"""Chibis level up the longer their viewer stays on the LIVE.

A viewer "is watching" from their first event (join, comment, like, gift, share, follow) and keeps
counting while they have done something in the last `level_presence_min` minutes — TikTok tells us
when somebody arrives, never when they leave, so a viewer who stays silent stops counting after a
while (a tap on the heart starts the clock again). The minutes are per LIVE session.

Levels (minutes from the scene settings, default 5 / 15 / 30):
  1 · nón lá   2 · áo choàng   3 · vương miện
On a level-up the Chibi celebrates and the owner congratulates (bubble, voice if on). A viewer who
is about a minute away from the next level hears the owner say so ("ở lại với quán nha!").
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.services.text_safety import speakable_name

if TYPE_CHECKING:
    from app.container import AppContainer
    from app.events.schema import EventUser

ITEMS = ("nón lá", "áo choàng", "vương miện")
VERBS = ("được đội nón lá", "được khoác áo choàng", "được đội vương miện")
PUBLISH_S = 5.0  # progress bars on the game: at most every 5 s
VOICE_GAP_S = 25.0  # owner's level lines on the voice: at most one every 25 s
REMIND_GAP_S = 90.0  # "1 phút nữa…": at most one every 90 s
REMIND_WINDOW = (40.0, 75.0)  # seconds before the next level
REMIND_ACTIVE_S = 180.0  # only viewers who did something in the last 3 minutes are reminded
MAX_WATCHERS = 20_000


@dataclass
class Watcher:
    key: str
    name: str
    watch_s: float = 0.0
    last_seen: float = 0.0
    level: int = 0
    reminded: set[int] = field(default_factory=set)


class LevelService:
    def __init__(self, c: AppContainer, clock=time.monotonic):
        self.c = c
        self.clock = clock
        self.session_id: str | None = None
        self.watchers: dict[str, Watcher] = {}
        self.active: set[str] = set()  # keys still counting (seen within the presence window)
        self._last_tick: float | None = None
        self._last_publish = 0.0
        self._last_voice = -1e9
        self._last_remind = -1e9
        self._sent: dict[str, tuple[int, float | None]] = {}  # avatar_id → (level, progress) last sent
        self.ups: list[dict[str, Any]] = []  # recent level-ups (dashboard)

    @property
    def scene(self):
        return self.c.scene

    def thresholds_s(self) -> list[float]:
        return [m * 60.0 for m in self.scene.level_minutes]

    def reset(self, session_id: str | None = None) -> None:
        self.session_id = session_id
        self.watchers.clear()
        self.active.clear()
        self._sent.clear()
        self.ups.clear()
        self._last_tick = None

    def level_of(self, key: str | None) -> int:
        w = self.watchers.get(key) if key else None
        return w.level if w and self.scene.levels_enabled else 0

    # ------------------------------------------------------------------ events
    def seen(self, user: EventUser | None) -> None:
        """Any event from this viewer: they are (still) here."""
        if user is None or not user.identity_key or not self.scene.levels_enabled:
            return
        key = user.identity_key
        w = self.watchers.get(key)
        now = self.clock()
        if w is None:
            if len(self.watchers) >= MAX_WATCHERS:
                self._forget_oldest()
            w = self.watchers[key] = Watcher(key, user.nickname or user.unique_id or "bạn", last_seen=now)
        else:
            w.last_seen = now
            if user.nickname:
                w.name = user.nickname
        self.active.add(key)

    def _forget_oldest(self) -> None:
        idle = sorted((w for k, w in self.watchers.items() if k not in self.active), key=lambda w: w.last_seen)
        for w in idle[: max(1, len(self.watchers) // 10)]:
            self.watchers.pop(w.key, None)

    # ------------------------------------------------------------------ clock
    def tick(self) -> None:
        now = self.clock()
        last, self._last_tick = self._last_tick, now
        if not self.scene.levels_enabled or not self.c.live.session_id or last is None:
            return
        dt = min(5.0, max(0.0, now - last))
        window = self.scene.level_presence_min * 60.0
        th = self.thresholds_s()
        gone = []
        for key in self.active:
            w = self.watchers.get(key)
            if w is None or now - w.last_seen > window:
                gone.append(key)
                continue
            w.watch_s += dt
            lvl = sum(1 for t in th if w.watch_s >= t)
            if lvl > w.level:
                w.level = lvl
                self._level_up(w, lvl)
            else:
                self._maybe_remind(w, th, now)
        for key in gone:
            self.active.discard(key)
        if now - self._last_publish >= PUBLISH_S:
            self._last_publish = now
            self.publish()

    # ------------------------------------------------------------------ what happens
    def _level_up(self, w: Watcher, lvl: int) -> None:
        av = self.c.avatars._by_key.get(w.key)
        item = ITEMS[lvl - 1]
        if av:
            av.level = lvl
            if av.visible:
                self.c.hub.send_game({"type": "AVATAR_LEVEL", "avatar_id": av.avatar_id, "level": lvl, "up": True, "item": item})
        minutes = self.scene.level_minutes[lvl - 1]
        name = speakable_name(w.name, self.c.assistant.config.banned_words)
        text = f"Chúc mừng {name} ở lại với quán {minutes} phút, Chibi {VERBS[lvl - 1]} nè!"
        if lvl == len(ITEMS):
            text += " Cảm ơn bạn nhiều nha!"
        self.ups.append({"name": w.name, "level": lvl, "item": item, "minutes": minutes, "at": time.time()})
        del self.ups[:-20]
        if av and av.visible:
            self.c.owner.say(text, kind="level")
        now = self.clock()
        if (self.scene.level_voice and av and av.visible and now - self._last_voice >= VOICE_GAP_S
                and self.c.assistant.announce("level", text)):
            self._last_voice = now

    def _maybe_remind(self, w: Watcher, th: list[float], now: float) -> None:
        if w.level >= len(th) or not self.scene.level_voice or (w.level + 1) in w.reminded:
            return
        left = th[w.level] - w.watch_s
        if not (REMIND_WINDOW[0] < left <= REMIND_WINDOW[1]) or now - w.last_seen > REMIND_ACTIVE_S:
            return
        if now - self._last_remind < REMIND_GAP_S or now - self._last_voice < VOICE_GAP_S:
            return
        av = self.c.avatars._by_key.get(w.key)
        if not av or not av.visible or self.c.speech.pending() > 0:
            return
        name = speakable_name(w.name, self.c.assistant.config.banned_words)
        text = f"{name} ơi, còn khoảng 1 phút nữa là Chibi của bạn {VERBS[w.level]} đó, ở lại với quán nha!"
        w.reminded.add(w.level + 1)
        if self.c.assistant.announce("level", text):
            self._last_remind = self._last_voice = now
            self.c.owner.say(text, kind="level")

    def progress(self, w: Watcher, now: float) -> float | None:
        """0…1 towards the next level while counting; None when not counting or at the top."""
        th = self.thresholds_s()
        if w.level >= len(th) or w.key not in self.active:
            return None
        if now - w.last_seen > self.scene.level_presence_min * 60.0:
            return None
        lo = th[w.level - 1] if w.level else 0.0
        return max(0.0, min(1.0, (w.watch_s - lo) / max(1.0, th[w.level] - lo)))

    def publish(self) -> None:
        """Progress bars of the Chibis on screen (only what changed)."""
        now = self.clock()
        items = []
        for av in self.c.avatars.visible():
            w = self.watchers.get(av.viewer_key)
            lvl = w.level if w else 0
            p = self.progress(w, now) if w else None
            p = None if p is None else round(p * 20) / 20
            if self._sent.get(av.avatar_id) != (lvl, p):
                self._sent[av.avatar_id] = (lvl, p)
                items.append([av.avatar_id, lvl, p])
        if items:
            self.c.hub.send_game({"type": "LEVEL_PROGRESS", "items": items})

    def try_next(self, name: str | None = None) -> dict[str, Any] | None:
        """Demo only (the host tries it out): a Chibi on screen jumps to its next level now."""
        if not self.c.live.is_demo or not self.scene.levels_enabled:
            return None
        th = self.thresholds_s()
        now = self.clock()
        for av in sorted(self.c.avatars.visible(), key=lambda a: a.shown_at):
            if name and av.nickname != name:
                continue
            w = self.watchers.get(av.viewer_key)
            if w is None:
                w = self.watchers[av.viewer_key] = Watcher(av.viewer_key, av.nickname, last_seen=now)
            if w.level >= len(th):
                continue
            w.last_seen = now
            self.active.add(w.key)
            w.watch_s = max(w.watch_s, th[w.level] - 1.0)  # the next tick crosses the mark
            return {"name": w.name, "next": ITEMS[w.level]}
        return None

    def view(self) -> dict[str, Any]:
        top = sorted(self.watchers.values(), key=lambda w: -w.watch_s)[:10]
        now = self.clock()
        return {
            "enabled": self.scene.levels_enabled,
            "minutes": list(self.scene.level_minutes),
            "items": list(ITEMS),
            "watching": len(self.active),
            "top": [{"name": w.name, "minutes": round(w.watch_s / 60, 1), "level": w.level,
                     "counting": self.progress(w, now) is not None or (w.key in self.active and w.level >= len(ITEMS))}
                    for w in top],
            "recent": list(reversed(self.ups[-8:])),
        }
