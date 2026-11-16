"""“Sắp diễn ra” — what is coming up on the LIVE, so viewers have a reason to stay a bit longer.

Rows (at most 4, soonest first), each with a time (wall clock, epoch ms) the screen counts down to:
  📜 the owner's next poem (every 10–15 minutes)
  👑 the next Chibi about to level up (within 3 minutes)
  🗓  the shop's own schedule (Không gian cửa hàng → Lịch LIVE: "22:10 Mini-game đoán giá"), the
     next ones within 90 minutes
plus a rotating "how to join in" line (stay for a level, comment "nhảy", comment "làm thơ").

Sent to the game as UPCOMING when it changes (checked every 2 s), and in the game snapshot.
"""

from __future__ import annotations

import datetime as dt
import time
from typing import TYPE_CHECKING, Any

from app.services.levels import ITEMS, VERBS

if TYPE_CHECKING:
    from app.container import AppContainer

CHECK_S = 2.0
LEVEL_SOON_S = 180.0
AGENDA_AHEAD_MIN = 90
MAX_ROWS = 4


def agenda_due(hhmm: str, now: dt.datetime) -> dt.datetime | None:
    """Today's (or, just after midnight, tomorrow's) time for "22:10"; None if it has passed."""
    try:
        h, m = (int(x) for x in hhmm.split(":"))
        due = now.replace(hour=h, minute=m, second=0, microsecond=0)
    except ValueError:
        return None
    if due < now - dt.timedelta(minutes=1):
        # an evening LIVE that runs past midnight: "00:30" after 23:00 means tonight
        if now.hour >= 18 and h < 6:
            due += dt.timedelta(days=1)
        else:
            return None
    return due


class UpcomingService:
    def __init__(self, c: AppContainer, clock=time.monotonic, wall=time.time):
        self.c = c
        self.clock = clock
        self.wall = wall
        self._last_check = -1e9
        self._last_sent: Any = None

    # ------------------------------------------------------------------ rows
    def rows(self) -> list[dict[str, Any]]:
        scene = self.c.scene
        now_wall = self.wall()
        now_ms = int(now_wall * 1000)
        live = bool(self.c.live.session_id)
        out: list[dict[str, Any]] = []

        # the owner's next poem
        nxt = self.c.talk.next_in() if live else None
        if nxt is not None:
            out.append({"kind": "poem", "icon": "📜", "text": "Chủ quán làm thơ tặng cả nhà",
                        "due": now_ms + int(nxt * 1000)})

        # the next Chibi to level up
        if live and scene.levels_enabled:
            lv = self.c.levels
            th = lv.thresholds_s()
            mono = lv.clock()
            best = None
            for key in list(lv.active):
                w = lv.watchers.get(key)
                if not w or w.level >= len(th) or mono - w.last_seen > scene.level_presence_min * 60.0:
                    continue
                left = th[w.level] - w.watch_s
                av = self.c.avatars._by_key.get(key)
                if 0 < left <= LEVEL_SOON_S and av and av.visible and (best is None or left < best[0]):
                    best = (left, w)
            if best:
                left, w = best
                out.append({"kind": "level", "icon": "👑", "text": f"{w.name} sắp {VERBS[w.level].replace('được ', '')}",
                            "due": now_ms + int(left * 1000), "item": ITEMS[w.level]})

        # the shop's own schedule
        shop_tz = dt.timezone(dt.timedelta(hours=scene.shop_utc_offset))
        now_local = dt.datetime.fromtimestamp(now_wall, tz=shop_tz)  # the shop's clock (Vietnam by default)
        ahead = now_local + dt.timedelta(minutes=AGENDA_AHEAD_MIN)
        agenda = []
        for item in scene.agenda:
            due = agenda_due(item.time, now_local)
            if due is not None and due <= ahead:
                agenda.append({"kind": "agenda", "icon": "🗓", "text": item.text, "due": int(due.timestamp() * 1000),
                               "clock": item.time})
        agenda.sort(key=lambda r: r["due"])
        out.extend(agenda[:2])

        # (the dance stage line has its own box on the screen)
        return sorted(out, key=lambda r: r["due"])[:MAX_ROWS]

    def tips(self) -> list[str]:
        """'How to join in' lines, shown one after another under the rows."""
        scene = self.c.scene
        ai = self.c.assistant.config
        tips = []
        if scene.levels_enabled:
            a, b, c = scene.level_minutes
            tips.append(f"Ở lại {a} phút: Chibi đội nón lá · {b} phút: áo choàng · {c} phút: vương miện")
        if scene.stage_enabled:
            tips.append("Bình luận “nhảy” để lên sân khấu")
        if ai.poem_story:
            tips.append("Bình luận “làm thơ” để chủ quán tặng bạn một bài thơ")
        return tips

    def view(self) -> dict[str, Any]:
        return {"enabled": self.c.scene.upcoming_enabled, "rows": self.rows(), "tips": self.tips()}

    # ------------------------------------------------------------------ push
    def tick(self) -> None:
        now = self.clock()
        if now - self._last_check < CHECK_S:
            return
        self._last_check = now
        v = self.view()
        # countdowns run on the screen: only send when a row appears/disappears, its text changes,
        # or its time moves by more than 15 s (e.g. a new poem was scheduled)
        sig = (v["enabled"], tuple(v["tips"]),
               tuple((r["kind"], r["text"], None if r["due"] is None else r["due"] // 15000) for r in v["rows"]))
        if sig != self._last_sent:
            self._last_sent = sig
            self.c.hub.send_game({"type": "UPCOMING", "upcoming": v})
