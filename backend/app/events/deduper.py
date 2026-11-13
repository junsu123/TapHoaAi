"""In-memory LRU+TTL deduplication. The DB unique index on live_events is the second
line of defence. Approximate (fingerprint) dedupe is labelled as such — we never claim
exactly-once delivery."""

from __future__ import annotations

import time
from collections import OrderedDict

from app.events.schema import EventType, LiveEvent


class Deduper:
    def __init__(self, max_entries: int = 50_000, ttl_seconds: float = 600.0, clock=time.monotonic):
        self._seen: OrderedDict[tuple[str, str, str], float] = OrderedDict()
        self.max_entries = max_entries
        self.ttl = ttl_seconds
        self.clock = clock
        self.dropped = 0

    def _evict(self, now: float) -> None:
        while self._seen:
            key, ts = next(iter(self._seen.items()))
            if now - ts > self.ttl or len(self._seen) > self.max_entries:
                self._seen.popitem(last=False)
            else:
                break

    def is_duplicate(self, ev: LiveEvent) -> bool:
        now = self.clock()
        self._evict(now)
        key = (ev.session_id, ev.provider, ev.event_id)
        if key in self._seen:
            self.dropped += 1
            return True
        self._seen[key] = now
        return False


class GiftStreakTracker:
    """T08: a streakable gift is sent repeatedly with a growing repeat_count while the
    streak is running; only the final message (repeat_end=True) is counted, once."""

    def __init__(self) -> None:
        self._finalised: set[tuple[str, str]] = set()
        self.total_gifts = 0

    def settle(self, ev: LiveEvent) -> int:
        """Returns the number of gifts to count for this event (0 when not final)."""
        if ev.type != EventType.GIFT:
            return 0
        p = ev.payload
        if p.get("streakable") and not p.get("repeat_end"):
            return 0
        user_key = ev.user.identity_key if ev.user else "anon"
        group = p.get("group_id") or ev.event_id
        key = (str(user_key), str(group))
        if key in self._finalised:
            return 0
        self._finalised.add(key)
        count = int(p.get("repeat_count", 1))
        self.total_gifts += count
        return count
