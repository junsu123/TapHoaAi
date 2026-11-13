"""GameActionQueue — the ONLY place that creates Chibi commands (SPEC C1, C3, C4, F2).

Per avatar: one active command + at most `max_pending` waiting ones; a per-viewer
cooldown between command starts; a stand-position reservation per shelf with TTL. A
command is only COMPLETED when the primary game client says so (F2: no success without
client confirmation)."""

from __future__ import annotations

import itertools
import statistics
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from app.services.camera_director import PRIORITY_PRODUCT, CameraDirector
from app.services.catalog import Catalog


class CmdStatus(StrEnum):
    QUEUED = "QUEUED"
    WAITING_SLOT = "WAITING_SLOT"
    DISPATCHED = "DISPATCHED"
    ACKED = "ACKED"
    STARTED = "STARTED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    TIMED_OUT = "TIMED_OUT"


TERMINAL = {CmdStatus.COMPLETED, CmdStatus.FAILED, CmdStatus.CANCELLED, CmdStatus.TIMED_OUT}
RUNNING = {CmdStatus.DISPATCHED, CmdStatus.ACKED, CmdStatus.STARTED}


@dataclass
class Command:
    command_id: str
    session_id: str
    avatar_id: str
    viewer_key: str
    product_id: str
    shelf_code: str
    slot_code: str
    action: str = "WALK_PICKUP_SHOW"
    status: CmdStatus = CmdStatus.QUEUED
    priority: int = PRIORITY_PRODUCT
    stand_index: int | None = None
    wait_index: int | None = None
    reason: str | None = None
    parent_event_id: str | None = None
    created_at: float = 0.0
    dispatched_at: float = 0.0
    started_at: float = 0.0
    send_attempts: int = 0
    received_monotonic: float = 0.0
    preempt_sent: bool = False
    show_seconds: float = 8.0

    def wire(self, sequence_hint: str | None = None) -> dict[str, Any]:
        return {
            "type": "CHARACTER_ACTION", "command_id": self.command_id, "avatar_id": self.avatar_id,
            "product_id": self.product_id, "shelf_id": self.shelf_code, "slot_id": self.slot_code,
            "stand_index": self.stand_index, "action": self.action,
            "parameters": {"show_seconds": self.show_seconds, "camera_priority": self.priority},
        }

    def summary(self) -> dict[str, Any]:
        return {"command_id": self.command_id, "avatar_id": self.avatar_id, "product_id": self.product_id,
                "shelf_id": self.shelf_code, "status": self.status.value, "reason": self.reason}


class StandReservations:
    """Stand positions in front of each shelf, leased with a TTL (C4)."""

    def __init__(self, ttl: float, clock=time.monotonic):
        self.ttl = ttl
        self.clock = clock
        self._holds: dict[tuple[str, int], tuple[str, float]] = {}

    def holder_index(self, shelf: str, avatar_id: str) -> int | None:
        for (sh, idx), (av, _exp) in self._holds.items():
            if sh == shelf and av == avatar_id:
                return idx
        return None

    def acquire(self, shelf: str, n_positions: int, avatar_id: str) -> int | None:
        self.expire()
        existing = self.holder_index(shelf, avatar_id)
        if existing is not None:
            self.renew(shelf, avatar_id)
            return existing
        for idx in range(n_positions):
            if (shelf, idx) not in self._holds:
                self._holds[(shelf, idx)] = (avatar_id, self.clock() + self.ttl)
                return idx
        return None

    def renew(self, shelf: str, avatar_id: str) -> None:
        idx = self.holder_index(shelf, avatar_id)
        if idx is not None:
            self._holds[(shelf, idx)] = (avatar_id, self.clock() + self.ttl)

    def release(self, shelf: str, avatar_id: str) -> None:
        idx = self.holder_index(shelf, avatar_id)
        if idx is not None:
            del self._holds[(shelf, idx)]

    def expire(self) -> list[tuple[str, str]]:
        now = self.clock()
        gone = [(k, v) for k, v in self._holds.items() if v[1] < now]
        for k, _ in gone:
            del self._holds[k]
        return [(k[0], v[0]) for k, v in gone]

    def occupied(self, shelf: str) -> int:
        return sum(1 for (sh, _i) in self._holds if sh == shelf)

    def clear(self) -> None:
        self._holds.clear()


@dataclass
class AvatarQueue:
    active: Command | None = None
    pending: deque[Command] = field(default_factory=deque)
    last_start: float = -1e9


class GameActionQueue:
    def __init__(self, hub, catalog: Catalog, camera: CameraDirector, *, cooldown: float = 5.0,
                 max_pending: int = 2, show_seconds: float = 8.0, reservation_ttl: float = 15.0,
                 ack_timeout: float = 5.0, action_timeout: float = 45.0, clock=time.monotonic,
                 persist: Callable[[Command], None] | None = None):
        self.hub = hub
        self.catalog = catalog
        self.camera = camera
        self.cooldown = cooldown
        self.max_pending = max_pending
        self.show_seconds = show_seconds
        self.ack_timeout = ack_timeout
        self.action_timeout = action_timeout
        self.clock = clock
        self.persist = persist or (lambda _c: None)
        self.reservations = StandReservations(reservation_ttl, clock)
        self.session_id: str | None = None
        self.queues: dict[str, AvatarQueue] = {}
        self.commands: dict[str, Command] = {}
        self.shelf_waiters: dict[str, deque[str]] = {}
        self.is_avatar_visible: Callable[[str], bool] = lambda _a: True
        self.on_update: Callable[[Command], None] = lambda _c: None
        self._ids = itertools.count(1)
        # NFR-01: event received → game ACK, only for commands dispatched without an
        # intentional wait (cooldown / stand position); waits are reported separately.
        self.latencies_ms: deque[float] = deque(maxlen=500)
        self.dispatch_ack_ms: deque[float] = deque(maxlen=500)
        self.waited_ms: deque[float] = deque(maxlen=500)
        self.completed = 0
        self.failed = 0
        camera.is_command_alive = self.is_alive

    # ------------------------------------------------------------------ helpers
    def reset(self, session_id: str | None) -> None:
        self.session_id = session_id
        self.queues.clear()
        self.commands.clear()
        self.shelf_waiters.clear()
        self.reservations.clear()

    def set_catalog(self, catalog: Catalog) -> None:
        self.catalog = catalog

    def is_alive(self, command_id: str) -> bool:
        c = self.commands.get(command_id)
        return c is not None and c.status not in TERMINAL

    def is_busy(self, avatar_id: str) -> bool:
        q = self.queues.get(avatar_id)
        return bool(q and (q.active or q.pending))

    def active_commands(self) -> list[Command]:
        return [q.active for q in self.queues.values() if q.active and q.active.status in RUNNING]

    def _set(self, cmd: Command, status: CmdStatus, reason: str | None = None) -> None:
        cmd.status = status
        if reason:
            cmd.reason = reason
        self.persist(cmd)
        self.on_update(cmd)

    def _new_id(self) -> str:
        return f"cmd_{int(time.time() * 1000) % 10**10:010d}_{next(self._ids):05d}"

    # ------------------------------------------------------------------ submit
    def submit(self, avatar_id: str, viewer_key: str, product_id: str, *, parent_event_id: str | None = None,
               received_monotonic: float = 0.0) -> tuple[Command | None, str]:
        """Returns (command, outcome). outcome in {queued, merged, no_location, no_session}."""
        if self.session_id is None:
            return None, "no_session"
        loc = self.catalog.location_of(product_id)
        if loc is None:
            return None, "no_location"
        q = self.queues.setdefault(avatar_id, AvatarQueue())
        if q.active and q.active.product_id == product_id and q.active.status not in TERMINAL:
            return q.active, "merged"
        for c in q.pending:
            if c.product_id == product_id:
                return c, "merged"
        cmd = Command(
            command_id=self._new_id(), session_id=self.session_id, avatar_id=avatar_id, viewer_key=viewer_key,
            product_id=product_id, shelf_code=loc[0], slot_code=loc[1], created_at=self.clock(),
            parent_event_id=parent_event_id, received_monotonic=received_monotonic, show_seconds=self.show_seconds,
        )
        self.commands[cmd.command_id] = cmd
        if len(q.pending) >= self.max_pending:
            dropped = q.pending.popleft()
            self._set(dropped, CmdStatus.CANCELLED, "replaced_by_newer")
        q.pending.append(cmd)
        self._set(cmd, CmdStatus.QUEUED)
        # C3: a newer command asks the running one to finish at a safe point
        if q.active and q.active.status in RUNNING and not q.active.preempt_sent:
            q.active.preempt_sent = True
            self.hub.send_game({"type": "PREEMPT", "command_id": q.active.command_id,
                                "avatar_id": avatar_id, "reason": "new_command"})
        self._advance(avatar_id)
        return cmd, "queued"

    # ------------------------------------------------------------------ dispatch
    def _advance(self, avatar_id: str) -> None:
        q = self.queues.get(avatar_id)
        if not q:
            return
        now = self.clock()
        if q.active and q.active.status == CmdStatus.WAITING_SLOT:
            self._try_acquire(q.active)
            return
        if q.active or not q.pending:
            return
        if not self.hub.has_primary() or not self.is_avatar_visible(avatar_id):
            return
        if now < q.last_start + self.cooldown:
            return
        cmd = q.pending.popleft()
        q.active = cmd
        self._try_acquire(cmd)

    def _try_acquire(self, cmd: Command) -> None:
        shelf = self.catalog.shelves.get(cmd.shelf_code)
        n = len(shelf.stand_positions) if shelf else 0
        waiters = self.shelf_waiters.setdefault(cmd.shelf_code, deque())
        # FIFO fairness: while others wait for this shelf, only the head may take a position
        if waiters and waiters[0] != cmd.command_id:
            idx = None
        else:
            idx = self.reservations.acquire(cmd.shelf_code, n, cmd.avatar_id) if n else None
        if idx is None:
            if cmd.status != CmdStatus.WAITING_SLOT:
                cmd.wait_index = len(waiters) % max(1, len(shelf.wait_positions) if shelf else 1)
                waiters.append(cmd.command_id)
                self._set(cmd, CmdStatus.WAITING_SLOT)
                self.hub.send_game({"type": "WAIT_NEAR_SHELF", "command_id": cmd.command_id,
                                    "avatar_id": cmd.avatar_id, "shelf_id": cmd.shelf_code,
                                    "wait_index": cmd.wait_index})
            return
        if cmd.command_id in waiters:
            waiters.remove(cmd.command_id)
        cmd.stand_index = idx
        self._dispatch(cmd)

    def _dispatch(self, cmd: Command) -> None:
        now = self.clock()
        q = self.queues[cmd.avatar_id]
        q.last_start = now
        cmd.dispatched_at = now
        cmd.send_attempts += 1
        self._set(cmd, CmdStatus.DISPATCHED)
        self.hub.send_game(cmd.wire())
        self.camera.request(cmd.avatar_id, cmd.command_id, cmd.priority)

    # ------------------------------------------------------------------ client feedback
    def on_client_message(self, msg: dict[str, Any]) -> None:
        mtype = msg.get("type")
        cmd = self.commands.get(str(msg.get("command_id", "")))
        if cmd is None or cmd.status in TERMINAL:
            return  # unknown or already finished: ignore (idempotent)
        if mtype == "ACK":
            if cmd.status == CmdStatus.DISPATCHED:
                now = self.clock()
                self.dispatch_ack_ms.append((now - cmd.dispatched_at) * 1000.0)
                waited = cmd.dispatched_at - cmd.created_at
                if cmd.received_monotonic and waited < 0.05:
                    self.latencies_ms.append((now - cmd.received_monotonic) * 1000.0)
                elif waited >= 0.05:
                    self.waited_ms.append(waited * 1000.0)
                self._set(cmd, CmdStatus.ACKED)
        elif mtype == "ACTION_STARTED":
            cmd.started_at = self.clock()
            self.reservations.renew(cmd.shelf_code, cmd.avatar_id)
            self._set(cmd, CmdStatus.STARTED)
        elif mtype == "ACTION_PROGRESS":
            self.reservations.renew(cmd.shelf_code, cmd.avatar_id)
        elif mtype == "ACTION_COMPLETED":
            self.completed += 1
            self._finish(cmd, CmdStatus.COMPLETED, msg.get("reason"))
        elif mtype == "ACTION_FAILED":
            self.failed += 1
            self._finish(cmd, CmdStatus.FAILED, str(msg.get("reason") or "client_failed")[:120])

    def _finish(self, cmd: Command, status: CmdStatus, reason: str | None = None) -> None:
        self.reservations.release(cmd.shelf_code, cmd.avatar_id)
        waiters = self.shelf_waiters.get(cmd.shelf_code)
        if waiters and cmd.command_id in waiters:
            waiters.remove(cmd.command_id)
        self._set(cmd, status, reason)
        q = self.queues.get(cmd.avatar_id)
        if q and q.active is cmd:
            q.active = None
        self.camera.release(cmd.command_id)
        self._advance(cmd.avatar_id)
        self._wake_shelf(cmd.shelf_code)

    def _wake_shelf(self, shelf_code: str) -> None:
        waiters = self.shelf_waiters.get(shelf_code)
        if not waiters:
            return
        head = self.commands.get(waiters[0])
        if head and head.status == CmdStatus.WAITING_SLOT:
            self._try_acquire(head)

    def cancel_avatar(self, avatar_id: str, reason: str) -> None:
        q = self.queues.pop(avatar_id, None)
        if not q:
            return
        for c in list(q.pending) + ([q.active] if q.active else []):
            if c.status not in TERMINAL:
                self.reservations.release(c.shelf_code, avatar_id)
                self._set(c, CmdStatus.CANCELLED, reason)

    # ------------------------------------------------------------------ periodic
    def tick(self) -> None:
        now = self.clock()
        for shelf_code, avatar_id in self.reservations.expire():
            q = self.queues.get(avatar_id)
            if q and q.active and q.active.shelf_code == shelf_code and q.active.status in RUNNING:
                self._timeout(q.active, "reservation_expired")
        for avatar_id, q in list(self.queues.items()):
            cmd = q.active
            if cmd and cmd.status == CmdStatus.DISPATCHED and now - cmd.dispatched_at > self.ack_timeout:
                if cmd.send_attempts < 2 and self.hub.has_primary():
                    cmd.send_attempts += 1
                    cmd.dispatched_at = now
                    self.hub.send_game(cmd.wire())  # same command_id → idempotent on client
                else:
                    self.failed += 1
                    self._timeout(cmd, "no_ack")
            elif cmd and cmd.status in RUNNING and now - cmd.dispatched_at > self.action_timeout:
                self._timeout(cmd, "action_timeout")
            elif cmd and cmd.status == CmdStatus.WAITING_SLOT and now - cmd.created_at > self.action_timeout:
                self._timeout(cmd, "slot_wait_timeout")
            else:
                self._advance(avatar_id)
        for shelf_code in list(self.shelf_waiters):
            self._wake_shelf(shelf_code)

    def _timeout(self, cmd: Command, reason: str) -> None:
        self.hub.send_game({"type": "RESET_AVATAR", "avatar_id": cmd.avatar_id,
                            "command_id": cmd.command_id, "reason": reason})
        self._finish(cmd, CmdStatus.TIMED_OUT, reason)

    def on_primary_changed(self) -> None:
        """A new primary renderer has no memory of in-flight commands; resend them."""
        for cmd in self.active_commands():
            cmd.dispatched_at = self.clock()
            cmd.send_attempts = 1
            if cmd.status != CmdStatus.DISPATCHED:
                self._set(cmd, CmdStatus.DISPATCHED, "resent_after_reconnect")

    # ------------------------------------------------------------------ metrics
    @staticmethod
    def _pct(values: deque[float]) -> dict[str, float | None]:
        data = sorted(values)
        if not data:
            return {"p50_ms": None, "p95_ms": None, "samples": 0}
        p95 = data[min(len(data) - 1, int(round(0.95 * (len(data) - 1))))]
        return {"p50_ms": round(statistics.median(data), 1), "p95_ms": round(p95, 1), "samples": len(data)}

    def latency_stats(self) -> dict[str, float | None]:
        """NFR-01 figure: event received by the adapter → command ACKed by the game."""
        return {**self._pct(self.latencies_ms),
                "dispatch_to_ack": self._pct(self.dispatch_ack_ms),
                "intentional_wait": self._pct(self.waited_ms)}

    def queue_depth(self) -> int:
        return sum(len(q.pending) + (1 if q.active else 0) for q in self.queues.values())
