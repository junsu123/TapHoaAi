"""Provider supervision: reconnect with backoff, manual stop, no fake connection (LIVE-06, T09, NFR-10)."""

import asyncio

from app.events.bus import EventBus
from app.events.deduper import Deduper
from app.providers.live_provider import Capability, LiveEventProvider, ProviderStatus
from app.services.live_session import Backoff, LiveSessionService


def test_backoff_grows_caps_and_stops():
    b = Backoff(base=1, cap=8, max_attempts=6, rng=lambda: 1.0)
    assert [b.next_delay() for _ in range(6)] == [1, 2, 4, 8, 8, 8]
    assert b.next_delay() is None


class FlakyProvider(LiveEventProvider):
    name = "flaky"

    def __init__(self, failures: int):
        super().__init__()
        self.failures = failures
        self.starts = 0
        self.stay = asyncio.Event()

    async def start(self):
        self.starts += 1
        await self._set_status(ProviderStatus.CONNECTING)
        if self.starts <= self.failures:
            raise ConnectionError("network down")
        await self._set_status(ProviderStatus.CONNECTED)
        await self._emit({"event_id": "e1", "type": "COMMENT", "user": {"platform_user_id": "u"},
                          "payload": {"text": "trà cà gai leo"}})
        await self.stay.wait()

    async def stop(self):
        self.stay.set()

    def capabilities(self):
        return {"comment": Capability.AVAILABLE}


async def test_reconnects_after_failures_and_dedupes_replay(db):
    statuses, sleeps = [], []

    async def fast_sleep(d):
        sleeps.append(d)

    bus = EventBus()
    svc = LiveSessionService(db, bus, Deduper(), lambda _s: None,
                             lambda st: statuses.append(st["status"]), sleep=fast_sleep)
    p = FlakyProvider(failures=2)
    await svc.start(p, url="https://www.tiktok.com/@x/live", unique_id="x")
    for _ in range(100):
        if svc.status == ProviderStatus.CONNECTED:
            break
        await asyncio.sleep(0.01)
    assert svc.status == ProviderStatus.CONNECTED and p.starts == 3
    assert statuses.count("Mất kết nối") == 2 and len(sleeps) == 2
    assert len(svc.reconnect_log) == 2
    assert bus.depth == 1
    await svc._on_raw_event({"event_id": "e1", "type": "COMMENT", "user": {"platform_user_id": "u"},
                             "payload": {"text": "trà cà gai leo"}})  # replay after reconnect
    assert bus.depth == 1
    await svc.stop()
    assert svc.status == ProviderStatus.DISCONNECTED and svc.session_id is None


async def test_manual_stop_cancels_retry_loop(db):
    async def slow_sleep(_d):
        await asyncio.sleep(10)

    svc = LiveSessionService(db, EventBus(), Deduper(), lambda _s: None, lambda _st: None, sleep=slow_sleep)
    p = FlakyProvider(failures=100)
    await svc.start(p)
    await asyncio.sleep(0.05)
    assert svc.status == ProviderStatus.LOST
    await asyncio.wait_for(svc.stop(), timeout=1)
    assert p.starts == 1 and svc.status == ProviderStatus.DISCONNECTED
