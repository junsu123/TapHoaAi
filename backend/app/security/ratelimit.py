from __future__ import annotations

import time
from collections import defaultdict, deque


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float, clock=time.monotonic):
        self.limit = limit
        self.window = window_seconds
        self.clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = self.clock()
        q = self._hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True


class LoginLockout:
    """Lock a (ip, username) pair after N failures for M minutes."""

    def __init__(self, max_failures: int, lock_seconds: float, clock=time.monotonic):
        self.max_failures = max_failures
        self.lock_seconds = lock_seconds
        self.clock = clock
        self._fails: dict[str, list[float]] = defaultdict(list)

    def is_locked(self, key: str) -> bool:
        now = self.clock()
        self._fails[key] = [t for t in self._fails[key] if now - t < self.lock_seconds]
        return len(self._fails[key]) >= self.max_failures

    def record_failure(self, key: str) -> None:
        self._fails[key].append(self.clock())

    def reset(self, key: str) -> None:
        self._fails.pop(key, None)
