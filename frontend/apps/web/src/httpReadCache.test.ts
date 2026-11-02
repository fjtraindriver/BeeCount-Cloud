import { beforeEach, describe, expect, it, vi } from 'vitest'

import { authedGet, authedPost, clearReadCache } from '@beecount/api-client'

// http.ts 的 /read GET 短缓存 + in-flight 合并(perf2):
// - 并发同 URL+token 只发一次 fetch,各自拿到独立对象
// - TTL 内重复调用不发新请求
// - 任何写请求成功后失效;非 /read/ 路径不缓存;错误响应不缓存;换 token 清空

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  clearReadCache()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

describe('authedGet /read cache', () => {
  it('合并并发同 URL 请求为一次 fetch,且返回值互相隔离', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ seq: fetchMock.mock.calls.length, items: [1, 2] })
    )
    const [a, b] = await Promise.all([
      authedGet<{ seq: number; items: number[] }>('/read/workspace/accounts?limit=500', 'tok-A'),
      authedGet<{ seq: number; items: number[] }>('/read/workspace/accounts?limit=500', 'tok-A')
    ])
    expect(fetchMock.mock.calls.length).toBe(1)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    a.items.push(99)
    const c = await authedGet<{ seq: number; items: number[] }>(
      '/read/workspace/accounts?limit=500',
      'tok-A'
    )
    expect(fetchMock.mock.calls.length).toBe(1) // TTL 内仍命中缓存
    expect(c.items).toEqual([1, 2]) // a 的修改没污染缓存
  })

  it('写请求成功后失效,下一次读重新发请求', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true })
      return jsonResponse({ seq: fetchMock.mock.calls.length })
    })
    await authedGet('/read/workspace/tags?limit=500', 'tok-A')
    await authedGet('/read/workspace/tags?limit=500', 'tok-A')
    expect(fetchMock.mock.calls.length).toBe(1)
    await authedPost('/write/ledgers/lg/tags', 'tok-A', { name: 'x' })
    await authedGet('/read/workspace/tags?limit=500', 'tok-A')
    expect(fetchMock.mock.calls.length).toBe(3) // POST + 失效后重拉
  })

  it('非 /read/ 路径不缓存', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }))
    await authedGet('/admin/users', 'tok-A')
    await authedGet('/admin/users', 'tok-A')
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('错误响应不进缓存,下一次调用重试', async () => {
    let n = 0
    fetchMock.mockImplementation(async () => {
      n += 1
      return n === 1 ? jsonResponse({ detail: 'boom' }, 500) : jsonResponse({ ok: true })
    })
    await expect(authedGet('/read/workspace/ledgers', 'tok-A')).rejects.toBeTruthy()
    const v = await authedGet<{ ok: boolean }>('/read/workspace/ledgers', 'tok-A')
    expect(v.ok).toBe(true)
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('token 变化时清空,不串号', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }))
    await authedGet('/read/workspace/accounts', 'tok-A')
    await authedGet('/read/workspace/accounts', 'tok-B')
    await authedGet('/read/workspace/accounts', 'tok-B')
    expect(fetchMock.mock.calls.length).toBe(2)
  })
})
