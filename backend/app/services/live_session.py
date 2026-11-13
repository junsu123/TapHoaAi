"""Live session lifecycle + provider supervision (LIVE-01/02/06, C6, NFR-10).

Only the provider may move the session to CONNECTED. Provider crashes are caught,
reported as LOST and retried with exponential backoff + jitter; a manual disconnect
cancels retries immediately."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import secrets
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from app.events.bus import EventBus
from app.events.deduper import Deduper
from app.events.normalizer import NormalizationError, normalize
from app.models import LiveSessionRow
from app.providers.demo_adapter import DemoProvider
from app.providers.live_provider import LiveEventProvider, ProviderStatus
from app.security.crypto import redact

log = logging.getLogger("chibi.live")

TERMINAL_STATUSES = {ProviderStatus.ENDED, ProviderStatus.OFFLINE, ProviderStatus.UNSUPPORTED}


class Backoff:
    def __init__(self, base: float = 1.0, cap: float = 60.0, max_attempts: int = 10, rng=random.random):
        self.base, self.cap, self.max_attempts, self.rng = base, cap, max_attempts, rng
        self.attempt = 0

    def next_delay(self) -> float | None:
        if self.attempt >= self.max_attempts:
            return None
        delay = min(self.cap, self.base * (2 ** self.attempt))
        self.attempt += 1
        return delay * (0.5 + self.rng() / 2)  # "equal jitter"

    def reset(self) -> None:
        self.attempt = 0


class LiveSessionService:
    def __init__(self, db, bus: EventBus, deduper: Deduper,
                 on_session_change: Callable[[str | None], None],
                 on_status: Callable[[dict[str, Any]], None],
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        self.db = db
        self.bus = bus
        self.deduper = deduper
        self.on_session_change = on_session_change
        self.on_status_cb = on_status
        self.sleep = sleep
        self.provider: LiveEventProvider | None = None
        self.session_id: str | None = None
        self.status: ProviderStatus = ProviderStatus.DISCONNECTED
        self.detail: str | None = None
        self.url: str | None = None
        self.unique_id: str | None = None
        self.reconnect_log: deque[dict[str, Any]] = deque(maxlen=50)
        self._supervisor: asyncio.Task | None = None
        self._manual_stop = False
        self.normalize_errors = 0

    # ------------------------------------------------------------------ status
    @property
    def is_demo(self) -> bool:
        return isinstance(self.provider, DemoProvider)

    def status_dict(self) -> dict[str, Any]:
        caps = {k: v.value for k, v in self.provider.capabilities().items()} if self.provider else {}
        return {
            "session_id": self.session_id, "status": self.status.value, "detail": self.detail,
            "provider": self.provider.name if self.provider else None, "url": self.url,
            "unique_id": self.unique_id, "room_id": self.provider.room_id if self.provider else None,
            "is_demo": self.is_demo, "capabilities": caps, "reconnect_log": list(self.reconnect_log),
        }

    async def _on_provider_status(self, status: ProviderStatus, detail: str | None) -> None:
        self.status = status
        self.detail = redact(detail) if detail else None
        if self.session_id:
            with self.db.session() as s:
                row = s.get(LiveSessionRow, self.session_id)
                if row:
                    row.status = status.value
                    if status in TERMINAL_STATUSES:
                        row.ended_at = datetime.now(UTC)
        self.on_status_cb(self.status_dict())

    async def _on_raw_event(self, raw: dict[str, Any]) -> None:
        if not self.session_id or not self.provider:
            return
        try:
            ev = normalize(raw, session_id=self.session_id, provider=self.provider.name,
                           simulated=self.is_demo)
        except NormalizationError:
            self.normalize_errors += 1
            return
        if self.deduper.is_duplicate(ev):
            return
        await self.bus.publish(ev)

    # ------------------------------------------------------------------ control
    async def start(self, provider: LiveEventProvider, *, url: str | None = None, unique_id: str | None = None) -> None:
        await self.stop()
        self._manual_stop = False
        self.provider = provider
        self.url, self.unique_id = url, unique_id
        self.session_id = f"{'demo' if isinstance(provider, DemoProvider) else 'live'}_{secrets.token_hex(6)}"
        provider.on_raw_event = self._on_raw_event
        provider.on_status = self._on_provider_status
        with self.db.session() as s:
            s.add(LiveSessionRow(id=self.session_id, url=url, unique_id=unique_id,
                                 status=ProviderStatus.CHECKING.value, provider=provider.name))
        self.on_session_change(self.session_id)
        self.status = ProviderStatus.CHECKING
        self.reconnect_log.clear()
        if isinstance(provider, DemoProvider):
            await provider.start()  # in-process, cannot fail
        else:
            self._supervisor = asyncio.create_task(self._supervise(provider), name="provider-supervisor")

    async def _supervise(self, provider: LiveEventProvider) -> None:
        backoff = Backoff()
        while not self._manual_stop:
            try:
                await provider.start()
                if provider.status in TERMINAL_STATUSES or provider.status == ProviderStatus.CONNECTED:
                    backoff.reset()
                if provider.status in TERMINAL_STATUSES:
                    return
                # A well-behaved provider's start() returns when its connection drops.
                if self._manual_stop:
                    return
                raise ConnectionError("provider connection closed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - isolate provider failures
                if self._manual_stop:
                    return
                delay = backoff.next_delay()
                entry = {"at": datetime.now(UTC).isoformat(), "error": redact(str(exc))[:200],
                         "attempt": backoff.attempt, "retry_in_s": round(delay, 1) if delay else None}
                self.reconnect_log.append(entry)
                log.warning("provider failure: %s", entry)
                await self._on_provider_status(ProviderStatus.LOST, "Đang thử kết nối lại…" if delay else "Đã dừng thử lại.")
                if delay is None:
                    return
                await self.sleep(delay)
                await self._on_provider_status(ProviderStatus.CONNECTING, None)

    async def stop(self) -> None:
        self._manual_stop = True
        if self._supervisor:
            self._supervisor.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._supervisor
            self._supervisor = None
        if self.provider:
            with contextlib.suppress(Exception):
                await self.provider.stop()
            if self.session_id:
                with self.db.session() as s:
                    row = s.get(LiveSessionRow, self.session_id)
                    if row and row.ended_at is None:
                        row.ended_at = datetime.now(UTC)
                        row.status = ProviderStatus.DISCONNECTED.value
        had_session = self.session_id is not None
        self.provider = None
        self.session_id = None
        self.status = ProviderStatus.DISCONNECTED
        self.detail = None
        if had_session:
            self.on_session_change(None)
            self.on_status_cb(self.status_dict())
