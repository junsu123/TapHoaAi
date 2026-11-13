"""CameraDirector — decides WHO is on camera; the client decides HOW (GAME-07/08).

Priority: product question/command 50 > gift 30 > join 10. A shot is held at least
`min_hold` seconds; a higher priority may take over only after that, equal priorities
wait their turn, so two simultaneous commands never make the camera flick back and forth."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

PRIORITY_PRODUCT = 50
PRIORITY_GIFT = 30
PRIORITY_JOIN = 10
STALE_SECONDS = 20.0


@dataclass
class Shot:
    avatar_id: str
    command_id: str | None
    priority: int
    requested_at: float
    started_at: float = 0.0
    done: bool = False
    max_seconds: float | None = None


class CameraDirector:
    def __init__(self, hub, min_hold: float = 4.0, clock=time.monotonic):
        self.hub = hub
        self.min_hold = min_hold
        self.clock = clock
        self.current: Shot | None = None
        self.queue: list[Shot] = []
        self.is_command_alive: Callable[[str], bool] = lambda _cid: True
        self._overview_sent = False

    def snapshot(self) -> dict:
        if self.current:
            return {"mode": "follow", "avatar_id": self.current.avatar_id, "command_id": self.current.command_id}
        return {"mode": "overview"}

    def request(self, avatar_id: str, command_id: str | None, priority: int, max_seconds: float | None = None) -> None:
        now = self.clock()
        if self.current and self.current.command_id == command_id and command_id is not None:
            return
        self.queue = [s for s in self.queue if not (s.command_id == command_id and command_id)]
        self.queue.append(Shot(avatar_id, command_id, priority, now, max_seconds=max_seconds))
        self.tick()

    def release(self, command_id: str) -> None:
        if self.current and self.current.command_id == command_id:
            self.current.done = True
        self.queue = [s for s in self.queue if s.command_id != command_id]
        self.tick()

    def forget_avatar(self, avatar_id: str) -> None:
        self.queue = [s for s in self.queue if s.avatar_id != avatar_id]
        if self.current and self.current.avatar_id == avatar_id:
            self.current.done = True
        self.tick()

    def _start(self, shot: Shot, now: float) -> None:
        shot.started_at = now
        self.current = shot
        self._overview_sent = False
        self.hub.send_game({"type": "CAMERA_FOCUS", "mode": "follow", "avatar_id": shot.avatar_id,
                            "command_id": shot.command_id, "priority": shot.priority})

    def tick(self) -> None:
        now = self.clock()
        self.queue = [
            s for s in self.queue
            if now - s.requested_at < STALE_SECONDS and (s.command_id is None or self.is_command_alive(s.command_id))
        ]
        self.queue.sort(key=lambda s: (-s.priority, s.requested_at))
        cur = self.current
        if cur is not None:
            held = now - cur.started_at
            if cur.max_seconds is not None and held >= cur.max_seconds:
                cur.done = True
            if cur.command_id and not self.is_command_alive(cur.command_id):
                cur.done = True
            can_switch = held >= self.min_hold
            if cur.done and can_switch:
                self.current = None
            elif can_switch and self.queue and self.queue[0].priority > cur.priority:
                self.current = None
            else:
                return
        if self.queue:
            self._start(self.queue.pop(0), now)
        elif not self._overview_sent:
            self._overview_sent = True
            self.hub.send_game({"type": "CAMERA_FOCUS", "mode": "overview"})
