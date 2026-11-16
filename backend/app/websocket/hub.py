"""WebSocket hub with per-channel sequence numbers (SPEC F3: snapshot -> sequenced events).

Services call send_game()/send_dashboard() synchronously; the sequence number is assigned
at enqueue time and a pump task delivers messages in order. A client that connects gets a
SNAPSHOT carrying the current sequence and ignores anything older."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import deque
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("chibi.ws")


# Per-client outbox limits: a client that cannot keep up (a laptop on bad Wi-Fi, a frozen
# browser tab) is disconnected once this many messages wait for it; it reconnects and gets a
# fresh SNAPSHOT. It never slows down anybody else, and memory stays bounded.
OUTBOX_LIMIT = {"primary": 6000, "viewer": 1500}
SEND_TIMEOUT_S = 5.0
MAX_BATCH = 400


class _Client:
    def __init__(self, ws: WebSocket, role: str, coalesce: float):
        self.ws = ws
        self.role = role
        self.coalesce = coalesce
        self.outbox: deque[dict[str, Any]] = deque()
        self.ready = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.overflowed = False

    @property
    def limit(self) -> int:
        return OUTBOX_LIMIT["primary" if self.role == "primary" else "viewer"]

    def push(self, msg: dict[str, Any]) -> bool:
        if self.overflowed:
            return False
        if len(self.outbox) >= self.limit:
            self.overflowed = True  # too slow: drop everything, it resyncs after reconnecting
            self.outbox.clear()
            self.ready.set()
            return False
        self.outbox.append(msg)
        self.ready.set()
        return True


class Channel:
    def __init__(self, name: str, coalesce: float = 0.0):
        self.name = name
        self.coalesce = coalesce  # wait this long to send several messages in one frame
        self.sequence = 0
        self.clients: dict[WebSocket, str] = {}  # ws -> role
        self.primary: WebSocket | None = None
        self._clients: dict[WebSocket, _Client] = {}
        self.started = False
        self.sent = 0
        self.frames = 0
        self.kicked_slow = 0

    def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.started = False
        for cl in list(self._clients.values()):
            if cl.task:
                cl.task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await cl.task

    def enqueue(self, msg: dict[str, Any]) -> dict[str, Any]:
        self.sequence += 1
        out = {"schema_version": 1, "sequence": self.sequence, **msg}
        if self.started:
            for cl in list(self._clients.values()):
                if not cl.push(out) and cl.overflowed:
                    self._kick(cl)
        return out

    def send_to(self, ws: WebSocket, msg: dict[str, Any]) -> None:
        """Targeted message (snapshot, pong) delivered in order with broadcasts."""
        cl = self._clients.get(ws)
        if cl is not None and self.started and not cl.push(msg) and cl.overflowed:
            self._kick(cl)

    def _kick(self, cl: _Client) -> None:
        """Too slow: stop sending, ask it to reconnect (it gets a fresh SNAPSHOT)."""
        if cl.ws not in self._clients:
            return
        self.kicked_slow += 1
        log.info("%s client too slow (%d messages waiting): reconnecting it", self.name, cl.limit)
        self.remove(cl.ws)
        with contextlib.suppress(RuntimeError):
            asyncio.get_running_loop().create_task(self._close(cl.ws, 4408))

    @staticmethod
    async def _close(ws: WebSocket, code: int) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(ws.close(code=code, reason="too slow, reconnect for a snapshot"), timeout=2.0)

    async def _sender(self, cl: _Client) -> None:
        ws = cl.ws
        while True:
            await cl.ready.wait()
            if cl.coalesce and not cl.overflowed:
                await asyncio.sleep(cl.coalesce)  # gather a few, send them in one frame
            cl.ready.clear()
            if cl.overflowed:
                return
            while cl.outbox:
                n = min(len(cl.outbox), MAX_BATCH)
                batch = [cl.outbox.popleft() for _ in range(n)]
                frame = batch[0] if n == 1 else {"type": "BATCH", "messages": batch}
                try:
                    await asyncio.wait_for(ws.send_json(frame), timeout=SEND_TIMEOUT_S)
                    self.sent += n
                    self.frames += 1
                except Exception:  # noqa: BLE001 - a dead client must not stop the others
                    log.info("dropping %s client after send failure", self.name)
                    self.remove(ws)
                    await self._close(ws, 4408)  # it reconnects at once instead of waiting for a timeout
                    return

    def add(self, ws: WebSocket, role: str) -> bool:
        """Returns True when this client became the primary renderer."""
        became_primary = False
        if role == "primary":
            if self.primary is not None and self.primary in self.clients:
                self.clients[self.primary] = "viewer"
                old = self._clients.get(self.primary)
                if old:
                    old.role = "viewer"
            self.primary = ws
            became_primary = True
        self.clients[ws] = role
        cl = _Client(ws, role, self.coalesce)
        self._clients[ws] = cl
        with contextlib.suppress(RuntimeError):  # no running loop (sync tests)
            cl.task = asyncio.get_running_loop().create_task(self._sender(cl), name=f"ws-send-{self.name}")
        return became_primary

    def remove(self, ws: WebSocket) -> None:
        self.clients.pop(ws, None)
        cl = self._clients.pop(ws, None)
        if cl and cl.task and cl.task is not asyncio.current_task():
            cl.task.cancel()
        if self.primary is ws:
            self.primary = None

    def role_of(self, ws: WebSocket) -> str | None:
        return self.clients.get(ws)

    def stats(self) -> dict[str, Any]:
        return {"clients": len(self.clients), "sent": self.sent, "frames": self.frames,
                "kicked_slow": self.kicked_slow,
                "max_outbox": max((len(c.outbox) for c in self._clients.values()), default=0)}


class Hub:
    def __init__(self) -> None:
        # the OBS page gets commands within ~30 ms; the dashboard is a person reading: 10 frames/s
        self.game = Channel("game", coalesce=0.03)
        self.dashboard = Channel("dashboard", coalesce=0.1)
        self.on_primary_changed: Callable[[], None] = lambda: None

    def start(self) -> None:
        self.game.start()
        self.dashboard.start()

    async def stop(self) -> None:
        await self.game.stop()
        await self.dashboard.stop()

    def send_game(self, msg: dict[str, Any]) -> None:
        self.game.enqueue(msg)

    def send_dashboard(self, msg: dict[str, Any]) -> None:
        self.dashboard.enqueue(msg)

    def has_primary(self) -> bool:
        return self.game.primary is not None


class RecordingHub:
    """Test double: records messages, optionally pretends a primary renderer exists."""

    def __init__(self, primary: bool = True):
        self.game_msgs: list[dict[str, Any]] = []
        self.dash_msgs: list[dict[str, Any]] = []
        self.primary = primary
        self.on_primary_changed: Callable[[], None] = lambda: None

    def send_game(self, msg: dict[str, Any]) -> None:
        self.game_msgs.append(msg)

    def send_dashboard(self, msg: dict[str, Any]) -> None:
        self.dash_msgs.append(msg)

    def has_primary(self) -> bool:
        return self.primary

    def of_type(self, t: str) -> list[dict[str, Any]]:
        return [m for m in self.game_msgs if m.get("type") == t]
