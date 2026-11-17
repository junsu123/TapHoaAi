"""Khách quen: viewers remembered from one LIVE to the next.

Every LIVE has a number (`seq`, counted separately for real LIVEs and demos). A viewer's profile
keeps how many LIVEs they came to (`visits`) and how many in a row (`streak`). The first time a
viewer shows up in a LIVE:
  * never seen before      → a new profile
  * seen in an earlier LIVE → "quay lại": visits + 1, streak + 1 if they came to the previous LIVE
                              (else 1); the owner welcomes them back by name, in place of the usual
                              hello ("A, Thu quay lại rồi! Buổi LIVE thứ 3 liên tiếp đó…")
  * seen in this same LIVE  → the server restarted mid-LIVE (a new session within 20 minutes of the
                              last one keeps the LIVE's number): their minutes and Chibi level carry on
A Chibi of a viewer with 3+ LIVEs wears a small heart by its name (AvatarInfo.visits).

Profiles are read in batches off the event loop (a thread), and written every 15 s through the
batched DB writer. The table is created at start-up when missing (the desktop app starts the
server without running migrations).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.models import ViewerProfile
from app.services.text_safety import speakable_name

if TYPE_CHECKING:
    from app.container import AppContainer
    from app.events.schema import EventUser

log = logging.getLogger(__name__)

STATE_KEY = "regulars_state"
CONTINUE_S = 20 * 60  # a LIVE started this soon after the last one is the same LIVE (restart)
LOAD_EVERY_S = 0.3
SAVE_EVERY_S = 15.0
WELCOME_GATHER_S = 2.5
WELCOME_GAP_S = 20.0
REGULAR_VISITS = 3
MAX_HERE = 50_000


class Regulars:
    def __init__(self, c: AppContainer, clock=time.time):
        self.c = c
        self.clock = clock
        self.kind = "live"
        self.seq = 0
        self.session_id: str | None = None
        self.here: dict[str, dict[str, Any]] = {}  # key → profile (as a dict) for this LIVE
        self._pending: dict[str, tuple[str, str]] = {}  # key → (name, kind) waiting to be looked up
        self._dirty: set[str] = set()
        self._welcome: list[tuple[str, dict[str, Any]]] = []
        self._welcome_since = 0.0
        self._last_welcome = -1e9
        self._last_save = 0.0
        self._task: asyncio.Task | None = None
        self.stats = {"new": 0, "returning": 0, "continued": 0}
        self.recent_back: list[dict[str, Any]] = []
        self._ensure_table()

    def _ensure_table(self) -> None:
        with contextlib.suppress(Exception):
            ViewerProfile.__table__.create(self.c.db.engine, checkfirst=True)

    # ------------------------------------------------------------------ LIVE numbers
    def _state(self) -> dict[str, Any]:
        raw = self.c.get_setting(STATE_KEY)
        try:
            d = json.loads(raw) if raw else {}
        except ValueError:
            d = {}
        return d if isinstance(d, dict) else {}

    def reset(self, session_id: str | None) -> None:
        """A LIVE starts (or ends: session_id None)."""
        self.save(force=True)
        if self.here:
            # written now (not with the next batch): the next LIVE reads these profiles back at once
            with contextlib.suppress(Exception):
                self.c.writer.flush_sync()
        self.here.clear()
        self._pending.clear()
        self._welcome.clear()
        self._last_welcome = -1e9
        self.stats = {"new": 0, "returning": 0, "continued": 0}
        self.recent_back.clear()
        self.session_id = session_id
        if not session_id:
            return
        self.kind = "demo" if session_id.startswith("demo") else "live"
        st = self._state()
        k = st.get(self.kind) or {"seq": 0, "alive": 0}
        now = self.clock()
        cont_s = float(os.environ.get("CHIBI_LIVE_CONTINUE_S", CONTINUE_S))  # (the e2e suite: 0)
        if now - float(k.get("alive", 0)) > cont_s or not k.get("seq"):
            k["seq"] = int(k.get("seq", 0)) + 1  # a new LIVE
        k["alive"] = now
        st[self.kind] = k
        self.seq = k["seq"]
        self.c.set_setting(STATE_KEY, json.dumps(st), secret=False)

    def _heartbeat(self) -> None:
        st = self._state()
        k = st.get(self.kind) or {"seq": self.seq}
        k["seq"], k["alive"] = self.seq, self.clock()
        st[self.kind] = k
        self.c.set_setting_later(STATE_KEY, json.dumps(st), secret=False)

    # ------------------------------------------------------------------ viewers
    def visits_of(self, key: str | None) -> int:
        p = self.here.get(key) if key else None
        return int(p["visits"]) if p else 0

    def seen(self, user: EventUser | None) -> None:
        """Any event of a viewer: the first one in this LIVE looks their profile up."""
        if user is None or not user.identity_key or not self.session_id:
            return
        key = user.identity_key
        p = self.here.get(key)
        if p is not None:
            p["last_seen"] = self.clock()
            return
        if key in self._pending or len(self.here) >= MAX_HERE:
            return
        self._pending[key] = (user.nickname or user.unique_id or "bạn", self.kind)
        if self._task is None:
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                self.load_pending_sync()  # no event loop (scripts, some tests)

    def _query(self, keys: list[str]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        with self.c.db.session() as s:
            for i in range(0, len(keys), 500):
                for r in s.execute(select(ViewerProfile).where(ViewerProfile.key.in_(keys[i:i + 500]))).scalars():
                    out[r.key] = {"key": r.key, "kind": r.kind, "name": r.name, "first_seen": r.first_seen.timestamp(),
                                  "visits": r.visits, "streak": r.streak, "last_seq": r.last_seq,
                                  "total_watch_s": r.total_watch_s, "best_level": r.best_level,
                                  "cur_watch_s": r.cur_watch_s, "cur_level": r.cur_level}
        return out

    def load_pending_sync(self) -> None:
        batch, self._pending = self._pending, {}
        if batch:
            self._apply(batch, self._query(list(batch)))

    async def _load_pending(self) -> None:
        batch, self._pending = self._pending, {}
        if not batch:
            return
        session = self.session_id
        found = await asyncio.to_thread(self._query, list(batch))
        if session == self.session_id:
            self._apply(batch, found)

    def _apply(self, batch: dict[str, tuple[str, str]], found: dict[str, dict[str, Any]]) -> None:
        now = self.clock()
        for key, (name, kind) in batch.items():
            p = found.get(key)
            if p is None:
                p = {"key": key, "kind": kind, "name": name, "first_seen": now, "visits": 1, "streak": 1,
                     "last_seq": self.seq, "total_watch_s": 0.0, "best_level": 0, "cur_watch_s": 0.0, "cur_level": 0}
                self.stats["new"] += 1
            elif p["last_seq"] == self.seq:
                # the same LIVE (the server restarted): minutes and level carry on
                self.c.levels.carry(key, name, p["cur_watch_s"], p["cur_level"])
                self.stats["continued"] += 1
            else:
                p["streak"] = p["streak"] + 1 if p["last_seq"] == self.seq - 1 else 1
                p["visits"] += 1
                p["total_watch_s"] += p["cur_watch_s"]
                p["cur_watch_s"], p["cur_level"], p["last_seq"] = 0.0, 0, self.seq
                self.stats["returning"] += 1
                self._back(key, name, p)
            p["name"], p["last_seen"] = name, now
            self.here[key] = p
            self._dirty.add(key)
            av = self.c.avatars._by_key.get(key)
            if av and av.visits != p["visits"]:
                av.visits = p["visits"]
                if av.visible:
                    self.c.hub.send_game({"type": "AVATAR_UPDATE", "avatar": av.to_dict()})

    def _back(self, key: str, name: str, p: dict[str, Any]) -> None:
        """Welcomed back by name, in place of the usual hello."""
        self.c.assistant.forget_welcome(key)
        self._welcome.append((name, p))
        if len(self._welcome) == 1:
            self._welcome_since = self.clock()
        self.recent_back.append({"name": name, "visits": p["visits"], "streak": p["streak"], "at": time.time()})
        del self.recent_back[:-20]

    def _flush_welcome(self, now: float) -> None:
        if not self._welcome or now - self._welcome_since < WELCOME_GATHER_S or now - self._last_welcome < WELCOME_GAP_S:
            return
        batch, self._welcome = self._welcome[:4], self._welcome[4:]
        if self._welcome:
            self._welcome_since = now
        self._last_welcome = now
        cfg = self.c.assistant.config
        names = [speakable_name(n, cfg.banned_words) for n, _ in batch]
        if len(batch) == 1:
            p = batch[0][1]
            if p["streak"] >= 2:
                text = f"A, {names[0]} quay lại rồi! Buổi LIVE thứ {p['streak']} liên tiếp đó, cảm ơn bạn nha!"
            else:
                text = f"A, {names[0]} quay lại với quán rồi, vui quá!"
        else:
            text = f"A, {', '.join(names[:-1])} và {names[-1]} quay lại với quán rồi, vui quá!"
        if self.c.scene.owner_enabled:
            self.c.owner.say(text, kind="talk")
        if cfg.greet_joins:
            self.c.assistant.announce("welcome", text)

    # ------------------------------------------------------------------ saving
    def save(self, force: bool = False) -> None:
        if not self._dirty and not force:
            return
        levels = self.c.levels
        rows = []
        for key in list(self._dirty) if not force else list(self.here):
            p = self.here.get(key)
            if not p:
                continue
            w = levels.watchers.get(key)
            if w is not None:
                p["cur_watch_s"], p["cur_level"] = w.watch_s, w.level
                p["best_level"] = max(p["best_level"], w.level)
            rows.append({"key": key, "kind": p["kind"], "name": p["name"][:128],
                         "first_seen": datetime.fromtimestamp(p["first_seen"], UTC),
                         "last_seen": datetime.fromtimestamp(p.get("last_seen", self.clock()), UTC),
                         "visits": p["visits"], "streak": p["streak"], "last_seq": p["last_seq"],
                         "total_watch_s": p["total_watch_s"], "best_level": p["best_level"],
                         "cur_watch_s": p["cur_watch_s"], "cur_level": p["cur_level"]})
        self._dirty.clear()
        if not rows:
            return

        def job(s, rows=rows):
            from sqlalchemy.dialects.sqlite import insert as sq_insert

            stmt = sq_insert(ViewerProfile)
            cols = ["name", "last_seen", "visits", "streak", "last_seq", "total_watch_s", "best_level",
                    "cur_watch_s", "cur_level"]
            stmt = stmt.on_conflict_do_update(index_elements=["key"], set_={c: stmt.excluded[c] for c in cols})
            s.execute(stmt, rows)

        self.c.writer.submit(("viewer_profiles", time.monotonic()), job)

    # ------------------------------------------------------------------ loop
    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self.save(force=True)

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(LOAD_EVERY_S)
            try:
                await self._load_pending()
                now = self.clock()
                self._flush_welcome(now)
                if now - self._last_save >= SAVE_EVERY_S and self.session_id:
                    self._last_save = now
                    # the minutes of everyone watching (for a restart) + profiles that changed
                    self._dirty.update(k for k in self.c.levels.active if k in self.here)
                    self.save()
                    self._heartbeat()
            except Exception:
                log.exception("Khách quen: lỗi khi đọc/lưu hồ sơ người xem")

    # ------------------------------------------------------------------ dashboard
    def view(self) -> dict[str, Any]:
        here = sorted(self.here.values(), key=lambda p: (-p["visits"], -p["streak"]))
        return {
            "seq": self.seq, "kind": self.kind, **self.stats,
            "regulars_here": sum(1 for p in self.here.values() if p["visits"] >= REGULAR_VISITS),
            "top": [{"name": p["name"], "visits": p["visits"], "streak": p["streak"],
                     "minutes": round((p["total_watch_s"] + (self.c.levels.watchers[p["key"]].watch_s
                                       if p["key"] in self.c.levels.watchers else p["cur_watch_s"])) / 60)}
                    for p in here[:12] if p["visits"] > 1],
            "recent_back": list(reversed(self.recent_back[-8:])),
        }
