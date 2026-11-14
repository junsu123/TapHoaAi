"""AvatarManager — one avatar per identified viewer per session (GAME-03, GAME-11).

Key = (session_id, platform_user_id) with unique_id as fallback; nickname is display
only. Viewers without any stable id never get an avatar (SPEC F1)."""

from __future__ import annotations

import hashlib
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.events.schema import EventUser

MAX_LABEL_CHARS = 16


def display_nickname(user: EventUser) -> str:
    name = (user.nickname or user.unique_id or "khách").strip()
    return name if len(name) <= MAX_LABEL_CHARS else name[: MAX_LABEL_CHARS - 1] + "…"


@dataclass
class Avatar:
    avatar_id: str
    viewer_key: str
    unique_id: str | None
    nickname: str
    appearance_seed: int
    is_demo: bool
    visible: bool = False
    created_at: float = 0.0
    last_active: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "avatar_id": self.avatar_id, "nickname": self.nickname, "unique_id": self.unique_id,
            "appearance_seed": self.appearance_seed, "is_demo": self.is_demo,
        }


class AvatarManager:
    def __init__(self, hub, max_visible: int = 60, idle_exit_seconds: float = 600, clock=time.monotonic):
        self.hub = hub
        self.max_visible = max(1, max_visible)
        self.idle_exit_seconds = idle_exit_seconds
        self.clock = clock
        self.session_id: str | None = None
        self._by_key: dict[str, Avatar] = {}
        self._by_id: dict[str, Avatar] = {}
        self.overflow: deque[str] = deque()
        self.is_busy: Callable[[str], bool] = lambda _avatar_id: False
        # latest viewer count reported by the platform (None = not reported, e.g. Demo)
        self.viewer_cap: int | None = None

    # ------------------------------------------------------------------ queries
    def get(self, avatar_id: str) -> Avatar | None:
        return self._by_id.get(avatar_id)

    def find(self, user: EventUser | None) -> Avatar | None:
        key = user.identity_key if user else None
        return self._by_key.get(key) if key else None

    def visible(self) -> list[Avatar]:
        return [a for a in self._by_id.values() if a.visible]

    @property
    def count(self) -> int:
        return len(self._by_id)

    # ------------------------------------------------------------------ lifecycle
    def reset(self, session_id: str | None) -> None:
        for av in self.visible():
            self.hub.send_game({"type": "AVATAR_EXIT", "avatar_id": av.avatar_id, "reason": "session_reset"})
        self.session_id = session_id
        self._by_key.clear()
        self._by_id.clear()
        self.overflow.clear()

    def get_or_create(self, user: EventUser | None, is_demo: bool = False) -> Avatar | None:
        if user is None or self.session_id is None:
            return None
        key = user.identity_key
        if key is None:
            return None
        now = self.clock()
        av = self._by_key.get(key)
        if av:
            av.last_active = now
            new_name = display_nickname(user)
            if new_name != av.nickname:
                av.nickname = new_name
                if av.visible:
                    self.hub.send_game({"type": "AVATAR_UPDATE", "avatar": av.to_dict()})
            if not av.visible and key not in self.overflow:
                self._try_show(av)
            return av
        digest = hashlib.sha256(f"{self.session_id}|{key}".encode()).hexdigest()
        av = Avatar(
            avatar_id=f"av_{digest[:12]}", viewer_key=key, unique_id=user.unique_id,
            nickname=display_nickname(user), appearance_seed=int(digest[12:20], 16),
            is_demo=is_demo, created_at=now, last_active=now,
        )
        self._by_key[key] = av
        self._by_id[av.avatar_id] = av
        self._try_show(av)
        return av

    def touch(self, avatar_id: str) -> None:
        av = self._by_id.get(avatar_id)
        if av:
            av.last_active = self.clock()

    def exit_all(self, reason: str) -> list[str]:
        """Everyone leaves the store (LIVE ended)."""
        gone = [a.avatar_id for a in self.visible()]
        for av in self.visible():
            self._hide(av, reason)
        self.overflow.clear()
        return gone

    def _show(self, av: Avatar) -> None:
        av.visible = True
        self.hub.send_game({"type": "AVATAR_SPAWN", "avatar": av.to_dict()})

    def _hide(self, av: Avatar, reason: str) -> None:
        av.visible = False
        self.hub.send_game({"type": "AVATAR_EXIT", "avatar_id": av.avatar_id, "reason": reason})

    def _try_show(self, av: Avatar) -> None:
        if len(self.visible()) < self.max_visible:
            self._show(av)
            return
        idle = [a for a in self.visible() if not self.is_busy(a.avatar_id)]
        if idle:
            victim = min(idle, key=lambda a: a.last_active)
            self._hide(victim, "make_room")
            self._show(av)
        else:
            self.overflow.append(av.viewer_key)

    def tick(self) -> None:
        now = self.clock()
        for av in self.visible():
            if now - av.last_active > self.idle_exit_seconds and not self.is_busy(av.avatar_id):
                self._hide(av, "idle")
        # more Chibis than people the platform says are watching → the least recently
        # active (and not busy) ones leave; a new interaction brings a viewer back
        if self.viewer_cap is not None:
            excess = len(self.visible()) - max(0, self.viewer_cap)
            if excess > 0:
                idle = sorted((a for a in self.visible() if not self.is_busy(a.avatar_id)), key=lambda a: a.last_active)
                for av in idle[:excess]:
                    self._hide(av, "viewer_count")
        while self.overflow:
            if len(self.visible()) >= self.max_visible:
                idle = [a for a in self.visible() if not self.is_busy(a.avatar_id)]
                if not idle:
                    break
                self._hide(min(idle, key=lambda a: a.last_active), "make_room")
            av = self._by_key.get(self.overflow.popleft())
            if av and not av.visible:
                self._show(av)
