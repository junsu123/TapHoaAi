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
# High viewership: Chibis come in at a steady pace (not 50 at once), a Chibi stays at least
# MIN_STAY_S before it can be sent away to make room, and the waiting line is bounded.
SPAWN_RATE = 3.0  # Chibis entering per second
SPAWN_BURST = 10
MIN_STAY_S = 40.0
VIP_MIN_STAY_S = 15.0  # a buyer / gift giver may take the place of a Chibi that has been here this long
QUIET_S = 20.0  # only Chibis whose viewer said nothing for this long make room
OVERFLOW_MAX = 300
PRIORITY = ("product", "stage", "gift")  # in this order (stage = their turn on the dance stage)
PRIORITY_TTL_S = 30.0
KEEP_VIEWERS = 5000
FORGET_AFTER_S = 600.0


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
    last_active: float = 0.0  # anything: like, comment, gift (keeps the Chibi from leaving idle)
    last_spoke: float = 0.0  # a comment or a gift (likes do not count when making room)
    shown_at: float = 0.0
    level: int = 0  # Chibi level from watch time (services/levels.py)
    medals: int = 0  # mini-game wins this LIVE (services/minigames.py)

    def to_dict(self) -> dict[str, Any]:
        return {
            "avatar_id": self.avatar_id, "nickname": self.nickname, "unique_id": self.unique_id,
            "appearance_seed": self.appearance_seed, "is_demo": self.is_demo, "level": self.level, "medals": self.medals,
        }


class AvatarManager:
    def __init__(self, hub, max_visible: int = 60, idle_exit_seconds: float = 600, clock=time.monotonic):
        self.hub = hub
        self.max_visible = max(1, max_visible)
        self.idle_exit_seconds = idle_exit_seconds
        self.clock = clock
        self.session_id: str | None = None
        self.level_of = lambda key: 0  # set by the container (LevelService.level_of)
        self.medals_of = lambda key: 0  # set by the container (MiniGames.medals_of)
        self._by_key: dict[str, Avatar] = {}
        self._by_id: dict[str, Avatar] = {}
        self.overflow: deque[str] = deque()
        # viewers who asked for a product or sent a gift: they come in first (first come, first
        # served; a request older than PRIORITY_TTL_S is stale, spec §4), at their own extra pace,
        # and may take the place of a Chibi that has been here a while even if still chatting
        # product requests come before gift givers (who are thanked on screen anyway)
        self.priority: dict[str, dict[str, float]] = {r: {} for r in PRIORITY}
        self._tokens = float(SPAWN_BURST)
        self._vip_tokens = float(SPAWN_BURST)
        self._tokens_at = clock()
        self._forgot_at = clock()
        self.pace = True  # off only while the performance benchmark fills the shop
        self.spawns = 0
        self.evictions = 0
        self.not_shown_joins = 0
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
        for q in self.priority.values():
            q.clear()

    def get_or_create(self, user: EventUser | None, is_demo: bool = False, reason: str = "comment") -> Avatar | None:
        """reason: "join" (only watching), "comment", "product" (asked for a product), "gift".
        When the shop is full, a viewer who only joined is not put in the waiting line — their
        Chibi comes in when they comment."""
        if user is None or self.session_id is None:
            return None
        key = user.identity_key
        if key is None:
            return None
        now = self.clock()
        av = self._by_key.get(key)
        if av:
            av.last_active = now
            if reason != "join":
                av.last_spoke = now
            new_name = display_nickname(user)
            if new_name != av.nickname:
                av.nickname = new_name
                if av.visible:
                    self.hub.send_game({"type": "AVATAR_UPDATE", "avatar": av.to_dict()})
            if not av.visible:
                if reason in PRIORITY:  # asked for a product / sent a gift: moves up the line
                    rank = PRIORITY.index(reason)
                    if any(key in self.priority[r] for r in PRIORITY[: rank + 1]):
                        return av  # already in this line (or a better one): keeps its place
                    if key in self.overflow:
                        self.overflow.remove(key)
                    for r in PRIORITY[rank + 1:]:
                        self.priority[r].pop(key, None)
                    self._try_show(av, reason)
                elif key not in self.overflow and not any(key in q for q in self.priority.values()):
                    self._try_show(av, reason)
            return av
        digest = hashlib.sha256(f"{self.session_id}|{key}".encode()).hexdigest()
        av = Avatar(
            avatar_id=f"av_{digest[:12]}", viewer_key=key, unique_id=user.unique_id,
            nickname=display_nickname(user), appearance_seed=int(digest[12:20], 16),
            is_demo=is_demo, created_at=now, last_active=now, last_spoke=now if reason != "join" else 0.0,
            level=self.level_of(key), medals=self.medals_of(key),
        )
        self._by_key[key] = av
        self._by_id[av.avatar_id] = av
        self._try_show(av, reason)
        return av

    def touch(self, avatar_id: str) -> None:
        av = self._by_id.get(avatar_id)
        if av:
            av.last_active = self.clock()

    def leave(self, avatar_id: str) -> bool:
        """The viewer asked to leave ("về thôi"): the Chibi waves and walks out. A later
        comment from the same viewer brings the same Chibi (same look) back."""
        av = self._by_id.get(avatar_id)
        if not av or not av.visible:
            return False
        self._hide(av, "user_leave")
        return True

    def exit_all(self, reason: str) -> list[str]:
        """Everyone leaves the store (LIVE ended)."""
        gone = [a.avatar_id for a in self.visible()]
        for av in self.visible():
            self._hide(av, reason)
        self.overflow.clear()
        for q in self.priority.values():
            q.clear()
        return gone

    def _show(self, av: Avatar) -> None:
        av.visible = True
        av.shown_at = self.clock()
        self.spawns += 1
        self.hub.send_game({"type": "AVATAR_SPAWN", "avatar": av.to_dict()})

    def _hide(self, av: Avatar, reason: str) -> None:
        av.visible = False
        self.hub.send_game({"type": "AVATAR_EXIT", "avatar_id": av.avatar_id, "reason": reason})

    def _take_token(self, reason: str = "comment") -> bool:
        if not self.pace:
            return True
        now = self.clock()
        dt = now - self._tokens_at
        self._tokens_at = now
        self._tokens = min(float(SPAWN_BURST), self._tokens + dt * SPAWN_RATE)
        self._vip_tokens = min(float(SPAWN_BURST), self._vip_tokens + dt * SPAWN_RATE)
        if reason in PRIORITY and self._vip_tokens >= 1.0:
            self._vip_tokens -= 1.0  # buyers and gift givers have a pace of their own
            return True
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False

    def _evictable(self, strict: bool = True) -> Avatar | None:
        """The Chibi that has been quiet the longest, if any may leave to make room.
        strict (for chatters): here at least MIN_STAY_S and its viewer said nothing for QUIET_S.
        Not strict (for a buyer / gift giver): here at least VIP_MIN_STAY_S, not busy."""
        now = self.clock()
        stay = MIN_STAY_S if strict else VIP_MIN_STAY_S
        idle = [a for a in self.visible()
                if not self.is_busy(a.avatar_id) and now - a.shown_at >= stay
                and (not strict or now - a.last_spoke >= QUIET_S)]
        return min(idle, key=lambda a: a.last_spoke) if idle else None

    def _queue(self, av: Avatar, reason: str = "comment") -> None:
        key = av.viewer_key
        if reason in PRIORITY:
            q = self.priority[reason]
            if key in q:
                return  # keeps its place in line
            q[key] = self.clock()
            if len(q) > OVERFLOW_MAX:
                q.pop(next(iter(q)))
            return
        if key in self.overflow:
            return
        if len(self.overflow) >= OVERFLOW_MAX:
            self.overflow.popleft()  # the one waiting longest has probably left the LIVE
        self.overflow.append(key)

    @property
    def waiting(self) -> int:
        return len(self.overflow) + sum(len(q) for q in self.priority.values())

    def _try_show(self, av: Avatar, reason: str = "comment") -> None:
        full = len(self.visible()) >= self.max_visible
        waiting_vip = any(self.priority.values())
        if reason not in PRIORITY and waiting_vip:
            # buyers / gift givers are waiting: the next places are theirs
            if reason == "join" and full:
                self.not_shown_joins += 1
                return
            self._queue(av, reason)
            return
        if reason in PRIORITY and any(self.priority[r] for r in PRIORITY[: PRIORITY.index(reason) + 1]):
            self._queue(av, reason)  # others asked first: in line behind them
            return
        if not full and self._take_token(reason):
            self._show(av)
            return
        if full:
            victim = self._evictable(strict=reason not in PRIORITY)
            if victim and reason != "join" and self._take_token(reason):
                self._hide(victim, "make_room")
                self.evictions += 1
                self._show(av)
                return
            if reason == "join":
                self.not_shown_joins += 1  # only watching: comes in when they comment
                return
        self._queue(av, reason)

    def _forget_old(self, now: float) -> None:
        """Thousands of viewers came and went: forget the ones long gone. Nothing is lost — a
        viewer who comes back gets the very same Chibi (id and look come from a hash)."""
        if len(self._by_key) <= KEEP_VIEWERS:
            return
        queued = set(self.overflow).union(*self.priority.values())
        for key, av in list(self._by_key.items()):
            if not av.visible and key not in queued and now - av.last_active > FORGET_AFTER_S:
                del self._by_key[key]
                self._by_id.pop(av.avatar_id, None)

    def tick(self) -> None:
        now = self.clock()
        if now - self._forgot_at > 30.0:
            self._forgot_at = now
            self._forget_old(now)
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
        # buyers, then gift givers — first come, first served; stale requests are dropped
        for reason in PRIORITY:
            q = self.priority[reason]
            for key in [k for k, t in q.items() if now - t > PRIORITY_TTL_S]:
                del q[key]
            while q:
                key = next(iter(q))
                av = self._by_key.get(key)
                if av is None or av.visible:
                    del q[key]
                    continue
                if not self._admit(av, strict=False, reason=reason):
                    return
                del q[key]
        # then everybody else, in order of arrival
        while self.overflow:
            av = self._by_key.get(self.overflow[0])
            if av is None or av.visible or now - av.last_active > self.idle_exit_seconds:
                self.overflow.popleft()  # already in, or waited too long without a word: gone
                continue
            if not self._admit(av, strict=True):
                break
            self.overflow.popleft()

    def _admit(self, av: Avatar, strict: bool, reason: str = "comment") -> bool:
        """Bring a waiting viewer in if there is (or can be made) room and the pace allows."""
        full = len(self.visible()) >= self.max_visible
        victim = self._evictable(strict) if full else None
        if full and victim is None:
            return False
        if not self._take_token(reason):
            return False
        if victim is not None:
            self._hide(victim, "make_room")
            self.evictions += 1
        self._show(av)
        return True
