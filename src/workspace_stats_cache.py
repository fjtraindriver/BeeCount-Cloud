"""Process-local cache for /workspace 聚合统计结果(analytics / tags)。

背景:/read/workspace/analytics 与 /read/workspace/tags 都是「把可见账本的
全部交易拉进 Python 逐行累加」的聚合端点,2 万笔账本单次要 5~10 秒;而
总览页一次刷新会并发多个 analytics 请求(year 的 expense / income 在服务
端是同一套计算,只是返回不同 metric 的分类排行),同一份全表扫描被重复
跑好几遍。

缓存策略(校验方式与 ``snapshot_cache`` 同思路:靠数据版本、不用 TTL 猜):
- key = 端点名 + 计算参数(analytics 不含 metric —— metric 只影响组装哪
  份 category_ranks,聚合本身与 metric 无关;tags 不含 limit/offset ——
  切片在缓存外做)。
- value = (数据版本, 存入时刻, 聚合结果的纯数据 dict/list)。
- 数据版本 = 可见账本集合的 ledger-scope ``MAX(change_id)`` 与相关用户
  user-scope ``MAX(change_id)`` 的组合(调用方计算,走
  ``idx_sync_changes_ledger_cursor`` / ``idx_sync_changes_user_scope_cursor``
  索引,毫秒级)。版本相等才命中;任何正常写路径(同步 push / Web 写 /
  导入)落 projection 时都会同事务写 SyncChange,版本必然变化,旧缓存
  自动失效,不会返回过期数字。
- 兜底 TTL(默认 300 秒):已知的例外是 admin 数据清理服务
  (services/data_cleanup)会直接 UPDATE projection 而不写 SyncChange,
  这类进程内改动靠 TTL 把陈旧窗口压到 5 分钟内;进程外直改 DB 的运维
  操作(如离线回填脚本)按其既有流程都要重启容器,重启即清缓存。
- 存取都做 deepcopy:缓存里只放纯数据,调用方每次用它重新组装响应
  对象,杜绝共享可变对象被某次请求改脏。
- 容量:OrderedDict 手工 LRU,上限 256 条。聚合结果按 (用户 × 账本集 ×
  scope × 周期) 计条目,个人/小团队自部署远达不到上限;多 worker 部署
  时各进程一份缓存,版本校验保证不会返错数据,只是各自冷启动重算一次。

没上 Redis 的理由同 snapshot_cache:单机自部署场景下进程内缓存足够,
真要多机共享再换也是 drop-in。
"""

from __future__ import annotations

import copy
import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Hashable
from typing import Any

logger = logging.getLogger(__name__)

_CAPACITY = 256
_TTL_SECONDS = 300.0


class _WorkspaceStatsCache:
    def __init__(
        self, capacity: int = _CAPACITY, ttl_seconds: float = _TTL_SECONDS
    ) -> None:
        self._capacity = capacity
        self._ttl_seconds = ttl_seconds
        # key -> (version, expires_at_monotonic, value)
        self._store: OrderedDict[Hashable, tuple[Any, float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Hashable, version: Any) -> Any | None:
        """版本一致且未过 TTL 才命中,返回值的 deepcopy;否则 None。"""
        with self._lock:
            hit = self._store.get(key)
            if hit is None:
                logger.debug("workspace_stats_cache miss kind=%s (empty)", _kind(key))
                return None
            cached_version, expires_at, value = hit
            if cached_version != version:
                # 数据已变 —— 删掉,调用方重算后 put 回来
                self._store.pop(key, None)
                logger.debug("workspace_stats_cache miss kind=%s (stale)", _kind(key))
                return None
            if time.monotonic() > expires_at:
                self._store.pop(key, None)
                logger.debug("workspace_stats_cache miss kind=%s (ttl)", _kind(key))
                return None
            self._store.move_to_end(key)
            logger.debug("workspace_stats_cache hit kind=%s", _kind(key))
            return copy.deepcopy(value)

    def put(self, key: Hashable, version: Any, value: Any) -> None:
        with self._lock:
            self._store[key] = (
                version,
                time.monotonic() + self._ttl_seconds,
                copy.deepcopy(value),
            )
            self._store.move_to_end(key)
            while len(self._store) > self._capacity:
                self._store.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()

    def size(self) -> int:
        with self._lock:
            return len(self._store)


def _kind(key: Hashable) -> str:
    """日志只打 key 的端点名一段,不把账本/用户 id 写进日志。"""
    if isinstance(key, tuple) and key:
        return str(key[0])
    return "?"


_instance = _WorkspaceStatsCache()


def get(key: Hashable, version: Any) -> Any | None:
    return _instance.get(key, version)


def put(key: Hashable, version: Any, value: Any) -> None:
    _instance.put(key, version, value)


def clear() -> None:
    _instance.clear()


def size() -> int:
    return _instance.size()
