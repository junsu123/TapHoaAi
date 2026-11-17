"""The dance stage: viewers sign up by commenting ("nhảy", "đăng ký nhảy", "lên sân khấu");
whoever comments first dances first. One performer at a time, for `stage_seconds`, while the
others wait in line (shown on the LIVE).

Flow for each performer (server decides, the OBS game page performs):
    queued ──► calling: their Chibi is brought into the shop if needed, finishes any product it
               is showing, then STAGE_PERFORM is sent and the Chibi walks to the stage
          ──► dancing: the game page reports STAGE_PROGRESS on_stage; the music runs for
               stage_seconds; then STAGE_END and the Chibi steps down
A performer who cannot come (left the LIVE, never got into the shop, page lost) is skipped
after a timeout, so the line never gets stuck.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.events.schema import EventUser
from app.services.camera_director import PRIORITY_GIFT, PRIORITY_PRODUCT
from app.services.text_safety import speakable_name

if TYPE_CHECKING:
    from app.container import AppContainer

PRIORITY_STAGE = (PRIORITY_PRODUCT + PRIORITY_GIFT) // 2
CALL_TIMEOUT_S = 30.0  # to get into the shop, finish a product and walk onto the stage
GAP_S = 2.0  # between two performers
AGAIN_S = 60.0  # the same viewer may sign up again this long after dancing
THANKS = "Cảm ơn {ten} đã nhảy tặng cả nhà ạ!"
CALL = "Mời bạn {ten} lên sân khấu!"
SOON = "{ten} ơi, sắp tới lượt bạn lên sân khấu rồi nha, đừng đi đâu nhé!"
SOON_MANY = "{ten} ơi, sắp tới lượt các bạn lên sân khấu rồi nha, đừng đi đâu nhé!"
SOON_AHEAD = 2  # "sắp tới lượt" when this many (or fewer) dance before you
SOON_GAP_S = 15.0  # at most one such call every 15 s (names are put together)
WALK_S = 8.0  # roughly: getting up on the stage


@dataclass
class Entry:
    key: str
    name: str
    user: EventUser
    is_demo: bool
    at: float = field(default_factory=time.monotonic)
    told_soon: bool = False  # "sắp tới lượt bạn" said already


@dataclass
class Performance:
    entry: Entry
    token: str
    phase: str = "calling"  # calling → dancing
    since: float = 0.0
    avatar_id: str | None = None
    sent: bool = False  # STAGE_PERFORM sent to the game page
    ends_at: float = 0.0


class StageService:
    def __init__(self, c: AppContainer, clock=time.monotonic):
        self.c = c
        self.clock = clock
        self.queue: deque[Entry] = deque()
        self.current: Performance | None = None
        self.done: dict[str, float] = {}  # key → when they last danced
        self.history: deque[dict[str, Any]] = deque(maxlen=30)
        self.performed = 0
        self.skipped = 0
        self._gap_until = 0.0
        self._n = 0
        self._dirty = True
        self._signed: list[str] = []  # names that just signed up (one owner bubble for several)
        self._signed_at = -1e9
        self._soon_last = -1e9
        self.soon_calls: list[dict[str, Any]] = []  # "sắp tới lượt bạn" said (dashboard / tests)
        self._published_at = -1e9

    # ------------------------------------------------------------------ settings
    @property
    def enabled(self) -> bool:
        return bool(self.c.scene.stage_enabled)

    @property
    def seconds(self) -> int:
        return int(self.c.scene.stage_seconds)

    @property
    def max_queue(self) -> int:
        return int(self.c.scene.stage_max_queue)

    # ------------------------------------------------------------------ viewers
    def register(self, user: EventUser | None, name: str, is_demo: bool = False) -> str:
        """A viewer asked to dance. Returns queued | already | performing | again_later | full | off."""
        if not self.enabled:
            return "off"
        key = user.identity_key if user else None
        if not key:
            return "off"  # nobody without a stable id gets a Chibi (spec T18)
        if self.current and self.current.entry.key == key:
            return "performing"
        if any(e.key == key for e in self.queue):
            return "already"  # keeps their place: commenting again does not move anybody
        if self.clock() - self.done.get(key, -1e9) < AGAIN_S:
            return "again_later"
        if len(self.queue) >= self.max_queue:
            return "full"
        self.queue.append(Entry(key, name, user, is_demo, self.clock()))
        self._signed.append(name)
        self._dirty = True
        return "queued"

    def position(self, key: str) -> int | None:
        for i, e in enumerate(self.queue):
            if e.key == key:
                return i + 1
        return None

    def remove(self, key: str) -> bool:
        """The viewer left ("về thôi") or the host removed them from the line."""
        if self.current and self.current.entry.key == key:
            self._end(skipped=True, reason="left")
            return True
        for e in list(self.queue):
            if e.key == key:
                self.queue.remove(e)
                self._dirty = True
                return True
        return False

    def skip(self) -> bool:
        if not self.current:
            return False
        self._end(skipped=True, reason="host")
        return True

    def clear(self) -> None:
        """Empty the waiting line (whoever is on the stage finishes their turn)."""
        self.queue.clear()
        self._dirty = True

    def reset(self) -> None:
        """New LIVE session: an empty stage."""
        self.queue.clear()
        self.current = None
        self.done.clear()
        self._dirty = True

    # ------------------------------------------------------------------ coupling with the shop
    def holds(self, avatar_id: str) -> bool:
        """This Chibi is on (or walking to) the stage: no product command for it meanwhile."""
        cur = self.current
        return bool(cur and cur.sent and cur.avatar_id == avatar_id)

    def involves(self, avatar_id: str) -> bool:
        """In line or performing: the Chibi must not be sent away to make room."""
        if self.current and self.current.avatar_id == avatar_id:
            return True
        av = self.c.avatars.get(avatar_id)
        return bool(av and any(e.key == av.viewer_key for e in self.queue))

    def on_client(self, msg: dict[str, Any]) -> None:
        cur = self.current
        if not cur or msg.get("token") != cur.token:
            return
        phase = msg.get("phase")
        if phase == "on_stage" and cur.phase == "calling":
            now = self.clock()
            cur.phase = "dancing"
            cur.since = now
            cur.ends_at = now + self.seconds
            self.c.camera.request(cur.avatar_id, None, PRIORITY_STAGE, max_seconds=5.0)
            self._dirty = True
        elif phase == "failed":
            self._end(skipped=True, reason="client")

    # ------------------------------------------------------------------ the show
    def tick(self) -> None:
        now = self.clock()
        cur = self.current
        if cur is not None:
            if cur.phase == "calling":
                self._call(cur, now)
            elif cur.phase == "dancing" and now >= cur.ends_at:
                self._end(skipped=False)
        elif self.queue and now >= self._gap_until and self.enabled:
            e = self.queue.popleft()
            self._n += 1
            self.current = Performance(e, token=f"st{self._n}", since=now)
            self._dirty = True
            self._call(self.current, now)
        self._flush_signed(now)
        self._tell_soon(now)
        if self.queue and now - self._published_at >= 10.0:
            self._dirty = True  # the waiting times on the screen stay about right
        if self._dirty:
            self._dirty = False
            self.publish()

    def _call(self, cur: Performance, now: float) -> None:
        if now - cur.since > CALL_TIMEOUT_S:
            self._end(skipped=True, reason="absent")
            return
        if cur.sent:
            return
        av = self.c.avatars.get_or_create(cur.entry.user, cur.entry.is_demo, reason="stage")
        if av is None:
            self._end(skipped=True, reason="absent")
            return
        cur.avatar_id = av.avatar_id
        if not av.visible or self.c.actions.is_busy(av.avatar_id) or not self.c.hub.has_primary():
            return  # coming in / finishing a product / no game page yet: wait (bounded above)
        cur.sent = True
        self.c.avatars.touch(av.avatar_id)
        self.c.hub.send_game({"type": "STAGE_PERFORM", "avatar_id": av.avatar_id, "token": cur.token,
                              "name": cur.entry.name, "seconds": self.seconds})
        self.c.owner.say(CALL.format(ten=cur.entry.name), kind="stage")
        self.c.assistant.announce("stage", CALL.format(ten=cur.entry.name))
        self._dirty = True

    def _end(self, *, skipped: bool, reason: str = "done") -> None:
        cur = self.current
        if cur is None:
            return
        self.current = None
        self._gap_until = self.clock() + GAP_S
        self.done[cur.entry.key] = self.clock()
        if len(self.done) > 5000:
            self.done = {k: t for k, t in self.done.items() if self.clock() - t < AGAIN_S}
        if cur.avatar_id and cur.sent:
            self.c.hub.send_game({"type": "STAGE_END", "avatar_id": cur.avatar_id, "token": cur.token})
            self.c.camera.forget_avatar(cur.avatar_id)
        if skipped:
            self.skipped += 1
        else:
            self.performed += 1
            self.c.owner.say(THANKS.format(ten=cur.entry.name), kind="stage")
        self.history.append({"name": cur.entry.name, "skipped": skipped, "reason": reason, "at": time.time()})
        self._dirty = True

    def _flush_signed(self, now: float) -> None:
        """"Đã ghi tên A, B lên sân khấu" — one owner bubble for everyone who just signed up."""
        if not self._signed or now - self._signed_at < 6.0:
            return
        from app.services.teahouse import name_list

        names = self._signed[:3]
        more = max(0, len(self._signed) - 3)
        self._signed = []
        self._signed_at = now
        self.c.owner.say(f"Đã ghi tên {name_list(names, more)} lên sân khấu ạ!", kind="stage")

    # ------------------------------------------------------------------ views
    def turn_s(self) -> float:
        """About how long one turn takes (dance + getting up there + the gap)."""
        return self.seconds + WALK_S + GAP_S

    def eta_s(self, index: int, now: float | None = None) -> int:
        """Rough wait for the viewer at queue[index]: what is left of the current turn + the turns before."""
        now = self.clock() if now is None else now
        cur = self.current
        left = 0.0
        if cur is not None:
            left = max(0.0, cur.ends_at - now) + GAP_S if cur.phase == "dancing" else self.seconds + WALK_S + GAP_S
        return round(left + index * self.turn_s())

    def _tell_soon(self, now: float) -> None:
        """Two (or fewer) to dance before you: the owner calls your name, so you stay."""
        if not self.enabled or now - self._soon_last < SOON_GAP_S:
            return
        ahead_now = 1 if self.current is not None else 0
        names = []
        for i, e in enumerate(list(self.queue)[:SOON_AHEAD + 1]):
            if ahead_now + i <= SOON_AHEAD and ahead_now + i > 0 and not e.told_soon:
                e.told_soon = True
                names.append(e.name)
        if not names:
            return
        self._soon_last = now
        cfg = self.c.assistant.config
        spoken = [speakable_name(n, cfg.banned_words) for n in names]
        text = (SOON if len(spoken) == 1 else SOON_MANY).format(ten=" và ".join(spoken))
        self.c.owner.say(text, kind="stage")
        self.c.assistant.announce("stage", text)
        self.soon_calls.append({"names": names, "at": time.time()})
        del self.soon_calls[:-20]

    def view(self) -> dict[str, Any]:
        cur = self.current
        now = self.clock()
        return {
            "enabled": self.enabled,
            "seconds": self.seconds,
            "max_queue": self.max_queue,
            "current": None if cur is None else {
                "name": cur.entry.name, "avatar_id": cur.avatar_id, "phase": cur.phase, "token": cur.token,
                "sent": cur.sent, "seconds_left": max(0, round(cur.ends_at - now)) if cur.phase == "dancing" else None,
            },
            "queue": [{"name": e.name, "key": e.key, "eta_s": self.eta_s(i, now)} for i, e in enumerate(list(self.queue)[:50])],
            "waiting": len(self.queue),
            "performed": self.performed,
            "skipped": self.skipped,
            "history": list(self.history)[-10:],
        }

    def publish(self) -> None:
        self._published_at = self.clock()
        v = self.view()
        game = {**v, "queue": [{"name": q["name"], "eta_s": q["eta_s"]} for q in v["queue"][:8]], "history": []}
        self.c.hub.send_game({"type": "STAGE_STATE", "stage": game})
        self.c.hub.send_dashboard({"type": "STAGE_STATE", "stage": v})
