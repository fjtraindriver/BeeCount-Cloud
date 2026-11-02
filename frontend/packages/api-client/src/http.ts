import { extractApiError } from './errors'

export const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/api/v1'

function resolveApiBaseUrl(): string | null {
  const normalized = `${API_BASE || ''}`.trim()
  if (!normalized) return null
  try {
    return new URL(normalized).toString()
  } catch (_) {
    if (typeof window === 'undefined') return null
    try {
      return new URL(normalized, window.location.origin).toString()
    } catch (_) {
      return null
    }
  }
}

export function resolveApiUrl(value?: string | null): string | null {
  const normalized = `${value || ''}`.trim()
  if (!normalized) return null
  try {
    return new URL(normalized).toString()
  } catch (_) {
    const base = resolveApiBaseUrl()
    if (!base) return normalized
    try {
      return new URL(normalized, base).toString()
    } catch (_) {
      return normalized
    }
  }
}

// ---------------------------------------------------------------------------
// Auth token coordination
// ---------------------------------------------------------------------------
//
// Without a global 401 handler every caller has to remember to check for
// ``status === 401`` and trigger a logout. In practice they don't, which means
// one expired token mid-session leaves the UI half-alive: reads fail silently,
// writes succeed until the next refresh. This module centralizes the retry:
// call sites keep passing the old token; if the server rejects it, we do a
// single-flight refresh here and replay the request transparently.

type RefreshFn = () => Promise<string>
type LogoutFn = () => void

let refreshFn: RefreshFn | null = null
let logoutFn: LogoutFn | null = null
let refreshInFlight: Promise<string> | null = null

/**
 * Wire the http layer to app-level auth callbacks. Call once after login
 * succeeds; no-op safe to call repeatedly.
 */
export function configureHttp(opts: { refreshToken?: RefreshFn | null; onLogout?: LogoutFn | null }): void {
  refreshFn = opts.refreshToken ?? null
  logoutFn = opts.onLogout ?? null
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw await extractApiError(res)
  }
  // 204 No Content 或 Content-Length: 0 的响应 (DELETE 撤销/删除 PAT 这种)
  // 没有 body,直接 `res.json()` 会抛 `Unexpected end of JSON input`。返
  // `undefined as T` —— 调用方签名是 `Promise<void>` 时 OK,期望 JSON
  // 的调用方本来就不会发出 204 请求。
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }
  return res.json()
}

/**
 * 公开 GET(无 Authorization header),目前用于 /version 这种不敏感且
 * 未登录也应该能打到的端点。
 */
export async function publicGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  })
  return parseResponse<T>(res)
}

export type BeeCountCloudVersion = {
  name: string
  version: string
}

export async function fetchCloudVersion(): Promise<BeeCountCloudVersion> {
  return publicGet<BeeCountCloudVersion>('/version')
}

/** 取当前浏览器 localStorage 存的 device_id(login 时落盘)。服务端鉴权中间件
 *  根据这个 header bump Device.last_seen_at,让"设备页最近活跃时间"真实反映
 *  web 操作而非"上次登录时间"。延迟 require 防止 auth.ts / http.ts 循环依赖。*/
function currentDeviceId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    // 跟 auth.ts 的 DEVICE_ID_KEY 同名同义,复制避免循环 import
    return window.localStorage.getItem(`beecount.web.device_id.${API_BASE}`)
  } catch {
    return null
  }
}

function authHeaders(token: string, idempotencyKey?: string): Record<string, string> {
  const out: Record<string, string> = {
    Authorization: `Bearer ${token}`
  }
  if (idempotencyKey) out['Idempotency-Key'] = idempotencyKey
  const deviceId = currentDeviceId()
  if (deviceId) out['X-Device-ID'] = deviceId
  return out
}

async function doRefresh(): Promise<string> {
  if (!refreshFn) throw new Error('no refresh configured')
  if (!refreshInFlight) {
    refreshInFlight = refreshFn().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

type FetchMaker = (token: string) => Promise<Response>

/**
 * Perform an authed fetch with transparent single-flight token refresh on 401.
 * Callers provide a factory that builds the request given the current token
 * string so we can replay the call with a refreshed token.
 */
async function authedFetch(makeRequest: FetchMaker, token: string): Promise<Response> {
  const res = await makeRequest(token)
  if (res.status !== 401) return res
  // Drain the body so we don't leak the connection on node/fetch implementations.
  try {
    await res.text()
  } catch (_) {
    // ignore
  }
  if (!refreshFn) {
    // No refresh path configured — surface 401 so caller logs out explicitly.
    logoutFn?.()
    return res
  }
  try {
    const fresh = await doRefresh()
    return await makeRequest(fresh)
  } catch (_) {
    logoutFn?.()
    return res
  }
}

// ---------------------------------------------------------------------------
// /read GET 短缓存 + in-flight 合并
// ---------------------------------------------------------------------------
//
// 背景:全仓十几个组件在各自挂载时独立拉 accounts / categories / tags /
// transactions,同一页面一次打开能发出十几个请求,其中不少 URL 完全相同
// (如 accounts?limit=500 被拉 3 次)。此前 authedGet 显式 cache:'no-store',
// 是担心 refresh-after-write 看到上一份数据 —— 那个担心成立,所以这里
// 不是无条件缓存,而是带三重保险的短缓存:
//   1. 只缓存路径以 /read/ 开头的 GET(写接口的 GET、/admin、/ai 等不碰);
//   2. TTL 只有 20 秒,且任何非 GET 的 authed 请求(POST/PATCH/PUT/
//      DELETE)成功后立刻清空 —— 写完再读永远走网络,原担心的场景不出现;
//   3. token 一变就清空,登出/换号不会串数据。
// 并发同 URL+token 的请求合并为一个 in-flight promise。缓存里存的是
// JSON 序列化字符串,每次命中都 JSON.parse 出新对象,调用方互改不脏。
// 错误响应(含最终 401)走 parseResponse 抛错路径,不会被缓存。

const READ_CACHE_TTL_MS = 20_000
const READ_CACHE_MAX_ENTRIES = 200

const readCache = new Map<string, { at: number; body: string }>()
const readInflight = new Map<string, Promise<string | undefined>>()
let readCacheToken: string | null = null

export function clearReadCache(): void {
  readCache.clear()
  readInflight.clear()
}

function isCacheableReadPath(path: string): boolean {
  return path.startsWith('/read/')
}

async function fetchAuthedGet(path: string, token: string): Promise<Response> {
  return authedFetch(
    (tok) =>
      fetch(`${API_BASE}${path}`, {
        headers: authHeaders(tok),
        // 浏览器/中间 CDN 层仍然拒绝缓存(见上方说明:这里的短缓存是
        // 应用层自己管失效的,跟 HTTP 缓存是两回事)。
        cache: 'no-store'
      }),
    token
  )
}

async function authedGetCached<T>(path: string, token: string): Promise<T> {
  if (readCacheToken !== token) {
    readCacheToken = token
    clearReadCache()
  }
  const hit = readCache.get(path)
  if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) {
    return JSON.parse(hit.body) as T
  }
  let inflight = readInflight.get(path)
  if (!inflight) {
    inflight = (async () => {
      const res = await fetchAuthedGet(path, token)
      const value = await parseResponse<unknown>(res)
      const body = JSON.stringify(value) as string | undefined
      if (body !== undefined) {
        if (readCache.size >= READ_CACHE_MAX_ENTRIES) readCache.clear()
        readCache.set(path, { at: Date.now(), body })
      }
      return body
    })().finally(() => {
      readInflight.delete(path)
    })
    readInflight.set(path, inflight)
  }
  const body = await inflight
  return (body === undefined ? undefined : JSON.parse(body)) as T
}

export async function authedGet<T>(path: string, token: string): Promise<T> {
  if (isCacheableReadPath(path)) {
    return authedGetCached<T>(path, token)
  }
  const res = await fetchAuthedGet(path, token)
  return parseResponse<T>(res)
}

export async function authedPost<T>(
  path: string,
  token: string,
  body: unknown,
  idempotencyKey?: string
): Promise<T> {
  const res = await authedFetch(
    (tok) =>
      fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          ...authHeaders(tok, idempotencyKey),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }),
    token
  )
  const value = await parseResponse<T>(res)
  clearReadCache()
  return value
}

export async function authedPatch<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await authedFetch(
    (tok) =>
      fetch(`${API_BASE}${path}`, {
        method: 'PATCH',
        headers: {
          ...authHeaders(tok),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }),
    token
  )
  const value = await parseResponse<T>(res)
  clearReadCache()
  return value
}

export async function authedPut<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await authedFetch(
    (tok) =>
      fetch(`${API_BASE}${path}`, {
        method: 'PUT',
        headers: {
          ...authHeaders(tok),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }),
    token
  )
  const value = await parseResponse<T>(res)
  clearReadCache()
  return value
}

export async function authedDelete<T>(path: string, token: string, body?: unknown): Promise<T> {
  const hasBody = typeof body !== 'undefined'
  const res = await authedFetch(
    (tok) =>
      fetch(`${API_BASE}${path}`, {
        method: 'DELETE',
        headers: hasBody
          ? {
              ...authHeaders(tok),
              'Content-Type': 'application/json'
            }
          : authHeaders(tok),
        body: hasBody ? JSON.stringify(body) : undefined
      }),
    token
  )
  const value = await parseResponse<T>(res)
  clearReadCache()
  return value
}
