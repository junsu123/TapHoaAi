"""Batched database writes for the busy paths (high viewership).

One commit per event used to cost more than everything else the server does for that event.
Here events, viewers and conversation rows are buffered and written together, in a worker
thread, a few times a second — one transaction per batch. The live pipeline never waits for
the disk; reads that need the latest rows call `flush_sync()` first.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import insert
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.models import LiveEventRow, Viewer

log = logging.getLogger("chibi.db_writer")

MAX_PENDING_EVENTS = 50_000  # memory guard if the disk stalls: oldest low-value rows go first


class DbWriter:
    def __init__(self, db, interval: float = 0.25):
        self.db = db
        self.interval = interval
        self._events: list[dict[str, Any]] = []
        self._viewers: dict[tuple[str, str], dict[str, Any]] = {}
        self._jobs: dict[Any, Callable[[Session], None]] = {}
        self._lock = threading.Lock()  # buffers are swapped under the lock; the write runs outside it
        self._write_lock = threading.Lock()  # one batch at a time
        self._retried: set[Any] = set()
        self._task: asyncio.Task | None = None
        self.written_events = 0
        self.written_viewers = 0
        self.batches = 0
        self.dropped = 0
        self.last_batch_ms = 0.0
        self.max_batch_ms = 0.0

    # ------------------------------------------------------------------ producers (event loop)
    def add_event(self, row: dict[str, Any]) -> None:
        with self._lock:
            if len(self._events) >= MAX_PENDING_EVENTS:
                self._events.pop(0)
                self.dropped += 1
            self._events.append(row)

    def touch_viewer(self, session_id: str, key: str, unique_id: str | None, nickname: str) -> None:
        with self._lock:
            self._viewers[(session_id, key)] = {"session_id": session_id, "platform_user_id": key,
                                                "unique_id": unique_id, "nickname": nickname,
                                                "last_seen_at": datetime.now(UTC)}

    def submit(self, key: Any, job: Callable[[Session], None]) -> None:
        """A write that may be coalesced: the latest job for the same key wins."""
        with self._lock:
            self._jobs.pop(key, None)
            self._jobs[key] = job

    def has_job(self, key: Any) -> bool:
        return key in self._jobs

    @property
    def pending(self) -> int:
        return len(self._events) + len(self._viewers) + len(self._jobs)

    # ------------------------------------------------------------------ writing (worker thread)
    def flush_sync(self) -> None:
        with self._write_lock:
            with self._lock:
                events, self._events = self._events, []
                viewers, self._viewers = self._viewers, {}
                jobs, self._jobs = self._jobs, {}
            if not (events or viewers or jobs):
                return
            t0 = time.perf_counter()
            try:
                self._write(events, list(viewers.values()), list(jobs.items()))
            except Exception:
                log.exception("Không ghi được dữ liệu sự kiện vào cơ sở dữ liệu (%d sự kiện)", len(events))
                return
            ms = (time.perf_counter() - t0) * 1000
            self.last_batch_ms = ms
            self.max_batch_ms = max(self.max_batch_ms, ms)
            self.batches += 1
            self.written_events += len(events)
            self.written_viewers += len(viewers)
            if len(self._retried) > 1000:
                self._retried.clear()

    def _write(self, events: list[dict[str, Any]], viewers: list[dict[str, Any]], jobs: list[tuple[Any, Callable]]) -> None:
        sqlite = self.db.engine.dialect.name == "sqlite"
        with self.db.session() as s:
            if events:
                if sqlite:
                    from sqlalchemy.dialects.sqlite import insert as sq_insert

                    s.execute(sq_insert(LiveEventRow).on_conflict_do_nothing(), events)
                else:  # pragma: no cover - other databases: row by row, skip duplicates
                    for e in events:
                        with contextlib.suppress(Exception), s.begin_nested():
                            s.execute(insert(LiveEventRow), [e])
            if viewers:
                if sqlite:
                    from sqlalchemy.dialects.sqlite import insert as sq_insert

                    stmt = sq_insert(Viewer)
                    stmt = stmt.on_conflict_do_update(
                        index_elements=["session_id", "platform_user_id"],
                        set_={"nickname": stmt.excluded.nickname, "last_seen_at": stmt.excluded.last_seen_at},
                    )
                    s.execute(stmt, viewers)
                else:  # pragma: no cover
                    for v in viewers:
                        row = s.query(Viewer).filter_by(session_id=v["session_id"],
                                                        platform_user_id=v["platform_user_id"]).one_or_none()
                        if row is None:
                            s.add(Viewer(**v))
                        else:
                            row.nickname, row.last_seen_at = v["nickname"], v["last_seen_at"]
            for key, job in jobs:
                try:
                    with s.begin_nested():
                        job(s)
                except OperationalError:
                    # busy disk / another writer: try again with the next batch (once)
                    if key not in self._retried:
                        self._retried.add(key)
                        self.submit(key, job)
                    else:
                        log.exception("Không ghi được một dòng dữ liệu")
                except Exception:
                    log.exception("Không ghi được một dòng dữ liệu")

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="db-writer")

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            if self.pending:
                await asyncio.to_thread(self.flush_sync)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        await asyncio.to_thread(self.flush_sync)

    def view(self) -> dict[str, Any]:
        return {"pending": self.pending, "batches": self.batches, "written_events": self.written_events,
                "last_batch_ms": round(self.last_batch_ms, 1), "max_batch_ms": round(self.max_batch_ms, 1),
                "dropped": self.dropped}
