"""WebSocket hub with per-channel sequence numbers (SPEC F3: snapshot -> sequenced events).

Services call send_game()/send_dashboard() synchronously; the sequence number is assigned
at enqueue time and a pump task delivers messages in order. A client that connects gets a
SNAPSHOT carrying the current sequence and ignores anything older."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("chibi.ws")


class Channel:
    def __init__(self, name: str):
        self.name = name
        self.sequence = 0
        self.clients: dict[WebSocket, str] = {}  # ws -> role
        self.primary: WebSocket | None = None
        self._queue: asyncio.Queue[tuple[WebSocket | None, dict[str, Any]]] | None = None
        self._task: asyncio.Task | None = None
        self.sent = 0

    def start(self) -> None:
        self._queue = asyncio.Queue()
        self._task = asyncio.create_task(self._pump(), name=f"ws-pump-{self.name}")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def enqueue(self, msg: dict[str, Any]) -> dict[str, Any]:
        self.sequence += 1
        out = {"schema_version": 1, "sequence": self.sequence, **msg}
        if self._queue is not None:
            self._queue.put_nowait((None, out))
        return out

    def send_to(self, ws: WebSocket, msg: dict[str, Any]) -> None:
        """Targeted message (snapshot, pong) delivered in order with broadcasts."""
        if self._queue is not None:
            self._queue.put_nowait((ws, msg))

    async def _pump(self) -> None:
        assert self._queue is not None
        while True:
            target, msg = await self._queue.get()
            for ws in ([target] if target is not None else list(self.clients)):
                if ws not in self.clients:
                    continue
                try:
                    await asyncio.wait_for(ws.send_json(msg), timeout=2.0)
                    self.sent += 1
                except Exception:  # noqa: BLE001 - a dead client must not stop the pump
                    log.info("dropping %s client after send failure", self.name)
                    self.remove(ws)

    def add(self, ws: WebSocket, role: str) -> bool:
        """Returns True when this client became the primary renderer."""
        became_primary = False
        if role == "primary":
            if self.primary is not None and self.primary in self.clients:
                self.clients[self.primary] = "viewer"
            self.primary = ws
            became_primary = True
        self.clients[ws] = role
        return became_primary

    def remove(self, ws: WebSocket) -> None:
        self.clients.pop(ws, None)
        if self.primary is ws:
            self.primary = None

    def role_of(self, ws: WebSocket) -> str | None:
        return self.clients.get(ws)


class Hub:
    def __init__(self) -> None:
        self.game = Channel("game")
        self.dashboard = Channel("dashboard")
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
