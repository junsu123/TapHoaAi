"""The tea house on the LIVE screen: the shop-owner Chibi's lines and the honour board.

* OwnerHost — viewers who join are greeted in a speech bubble ("Xin chào quý khách Lan, Minh
  và Hoa đã vào quán!"). Joins are gathered for a moment so a crowd becomes one bubble, nobody
  is greeted twice within 10 minutes, and bubbles never overlap. Gift givers are invited to the
  tea table; recorded purchases are thanked.
* Leaderboard — top gift givers (by coins, else by gift count) and top buyers (purchases the
  host records — orders are never guessed from comments or gifts).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from collections import deque
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.container import AppContainer

log = logging.getLogger("chibi.teahouse")

GREET_AGAIN_S = 600.0
GATHER_S = 1.2
BUBBLE_GAP_S = 4.2  # one greeting bubble at a time
NAMES_PER_BUBBLE = 3
# a gift storm: the owner can serve tea to one guest at a time (about 12 s each), so at most one
# invitation per TEA_GAP_S and the same viewer at most once per TEA_AGAIN_S; everyone else is
# thanked together in one bubble every THANKS_GAP_S
TEA_GAP_S = 15.0
TEA_AGAIN_S = 180.0
THANKS_GAP_S = 5.0
BOARD_PUBLISH_GAP_S = 1.0
BOARD_KEY = "leaderboard"
MAX_PURCHASES = 1000


def fill(template: str, **values: str) -> str:
    out = template
    for k, v in values.items():
        out = out.replace("{" + k + "}", v)
    return " ".join(out.split())


def name_list(names: list[str], more: int = 0) -> str:
    if more:
        return f"{', '.join(names)} và {more} bạn khác"
    if len(names) <= 1:
        return names[0] if names else ""
    return f"{', '.join(names[:-1])} và {names[-1]}"


def display_name(name: str | None) -> str:
    n = " ".join((name or "").split())
    return (n[:22] + "…") if len(n) > 23 else (n or "bạn")


class OwnerHost:
    def __init__(self, c: AppContainer) -> None:
        self.c = c
        self._greeted: dict[str, float] = {}
        self._pending: deque[tuple[str, float]] = deque()
        self._last_bubble = -1e9
        self._tea_last = -1e9
        self._tea_by: dict[str, float] = {}
        self._thanks: list[str] = []
        self._thanks_last = -1e9
        self._task: asyncio.Task | None = None
        self.history: deque[dict[str, Any]] = deque(maxlen=20)

    @property
    def scene(self):
        return self.c.scene

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="owner-greet")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(0.25)
            try:
                self.flush()
                self.flush_thanks()
            except Exception:  # never let the bubble loop die
                log.exception("Lỗi khi chủ quán chào khách")

    def _send(self, msg: dict[str, Any]) -> None:
        self.history.append({**msg, "at": time.time()})
        self.c.hub.send_game(msg)

    # ------------------------------------------------------------------ greetings
    def on_join(self, name: str | None, key: str | None) -> bool:
        if not self.scene.owner_enabled:
            return False
        now = time.monotonic()
        k = key or f"name:{name}"
        if now - self._greeted.get(k, -1e9) < GREET_AGAIN_S:
            return False
        self._greeted[k] = now
        if len(self._greeted) > 5000:  # forget the oldest
            for old in sorted(self._greeted, key=self._greeted.get)[:1000]:
                self._greeted.pop(old, None)
        self._pending.append((display_name(name), now))
        return True

    def flush(self, now: float | None = None) -> dict[str, Any] | None:
        if not self._pending:
            return None
        now = time.monotonic() if now is None else now
        if now - self._last_bubble < BUBBLE_GAP_S:
            return None
        if now - self._pending[0][1] < GATHER_S and len(self._pending) < NAMES_PER_BUBBLE:
            return None
        names = [self._pending.popleft()[0] for _ in range(min(NAMES_PER_BUBBLE, len(self._pending)))]
        more = 0
        # a crowd: greet three by name and the rest together, so the bubble never falls behind
        if len(self._pending) > NAMES_PER_BUBBLE * 2:
            more = len(self._pending)
            self._pending.clear()
        text = fill(self.scene.owner_greet_template, ten=name_list(names, more))
        self._last_bubble = now
        msg = {"type": "OWNER_GREET", "text": text, "names": names, "more": more}
        self._send(msg)
        return msg

    # ------------------------------------------------------------------ gifts & purchases
    def on_gift(self, avatar_id: str | None, name: str | None, gift_name: str | None, count: int) -> None:
        if not self.scene.owner_enabled:
            return
        now = time.monotonic()
        who = avatar_id or f"name:{name}"
        if now - self._tea_last >= TEA_GAP_S and now - self._tea_by.get(who, -1e9) >= TEA_AGAIN_S:
            self._tea_last = now
            self._tea_by[who] = now
            if len(self._tea_by) > 5000:
                self._tea_by = {k: t for k, t in self._tea_by.items() if now - t < TEA_AGAIN_S}
            gift = f"{count} {gift_name}" if gift_name and count > 1 else (gift_name or "quà")
            text = fill(self.scene.owner_tea_template, ten=display_name(name), qua=gift)
            self._send({"type": "OWNER_TEA", "avatar_id": avatar_id, "name": display_name(name), "text": text})
            return
        n = display_name(name)
        if n not in self._thanks and len(self._thanks) < 500:
            self._thanks.append(n)

    def flush_thanks(self, now: float | None = None) -> dict[str, Any] | None:
        """Many gifts at once: "Cảm ơn A, B, C và 12 bạn khác đã tặng quà ạ!" in one bubble."""
        if not self._thanks:
            return None
        now = time.monotonic() if now is None else now
        if now - self._thanks_last < THANKS_GAP_S or now - self._last_bubble < BUBBLE_GAP_S:
            return None
        names, more = self._thanks[:NAMES_PER_BUBBLE], max(0, len(self._thanks) - NAMES_PER_BUBBLE)
        self._thanks = []
        self._thanks_last = self._last_bubble = now
        msg = {"type": "OWNER_THANKS", "text": f"Cảm ơn {name_list(names, more)} đã tặng quà ạ!"}
        self._send(msg)
        return msg

    def say(self, text: str, kind: str = "talk") -> None:
        """A line in the owner's speech bubble (stage calls, thanks…), no voice by itself."""
        if not self.scene.owner_enabled or not text:
            return
        self._send({"type": "OWNER_SAY", "text": text[:200], "kind": kind})

    def on_purchase(self, name: str, product: str, qty: int) -> None:
        if not self.scene.owner_enabled:
            return
        what = f"{qty} {product}" if qty > 1 else product
        text = fill(self.scene.owner_buy_template, ten=display_name(name), san_pham=what)
        self._send({"type": "OWNER_THANKS", "text": text})


class Leaderboard:
    def __init__(self, c: AppContainer) -> None:
        self.c = c
        self.data: dict[str, Any] = {"session": None, "gifts": {}, "purchases": []}
        self._pub_last = -1e9
        self._pub_timer: asyncio.TimerHandle | None = None
        self._dirty = False
        raw = c.get_setting(BOARD_KEY)
        if raw:
            try:
                d = json.loads(raw)
                if isinstance(d, dict):
                    self.data = {"session": d.get("session"), "gifts": dict(d.get("gifts") or {}),
                                 "purchases": list(d.get("purchases") or [])}
            except (ValueError, TypeError):
                pass

    # ------------------------------------------------------------------ helpers
    def _save(self) -> None:
        # a gift storm changes the board hundreds of times a second: it is written at most
        # once a second (with the screen update), and once more when the app stops
        self._dirty = True

    def flush(self) -> None:
        if self._dirty:
            self._dirty = False
            self.c.set_setting_later(BOARD_KEY, json.dumps(self.data, ensure_ascii=False), secret=False)

    def _publish(self) -> None:
        """At most once a second (a gift storm changes it hundreds of times); the last change
        is never lost."""
        now = time.monotonic()
        if now - self._pub_last >= BOARD_PUBLISH_GAP_S:
            self._publish_now()
            return
        if self._pub_timer is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                self._publish_now()
                return
            self._pub_timer = loop.call_later(BOARD_PUBLISH_GAP_S - (now - self._pub_last), self._publish_now)

    def _publish_now(self) -> None:
        self._pub_timer = None
        self._pub_last = time.monotonic()
        self.flush()
        view = self.view()
        self.c.hub.send_game({"type": "LEADERBOARD", "board": view})
        self.c.hub.send_dashboard({"type": "LEADERBOARD", "board": view})

    def _session_check(self, session_id: str | None) -> None:
        """'Each LIVE' scope: a new LIVE starts a fresh board."""
        if self.c.scene.board_scope != "session" or not session_id:
            return
        if self.data.get("session") != session_id:
            if self.data.get("session") is not None:
                self.data["gifts"] = {}
                self.data["purchases"] = []
            self.data["session"] = session_id

    # ------------------------------------------------------------------ events
    def add_gift(self, key: str | None, name: str | None, count: int, diamonds_each: int,
                 session_id: str | None, is_demo: bool) -> None:
        if self.c.scene.board_scope == "all" and is_demo:
            return  # demo gifts never land on a long-running board
        self._session_check(session_id)
        k = key or f"name:{name}"
        g = self.data["gifts"].setdefault(k, {"name": display_name(name), "gifts": 0, "coins": 0})
        g["name"] = display_name(name) if name else g["name"]
        g["gifts"] += max(1, count)
        g["coins"] += max(0, diamonds_each) * max(1, count)
        g["last"] = time.time()
        self._save()
        self._publish()

    def add_purchase(self, *, name: str, key: str | None, product_id: str | None, product_name: str, qty: int,
                     amount: int) -> dict[str, Any]:
        self._session_check(self.c.live.session_id)
        p = {"id": uuid.uuid4().hex[:10], "key": key or f"name:{name.strip().lower()}", "name": display_name(name),
             "product_id": product_id, "product": product_name, "qty": qty, "amount": amount, "at": time.time()}
        self.data["purchases"].append(p)
        del self.data["purchases"][:-MAX_PURCHASES]
        self._save()
        self._publish()
        return p

    def remove_purchase(self, pid: str) -> bool:
        before = len(self.data["purchases"])
        self.data["purchases"] = [p for p in self.data["purchases"] if p["id"] != pid]
        if len(self.data["purchases"]) == before:
            return False
        self._save()
        self._publish()
        return True

    def reset(self) -> None:
        self.data = {"session": self.c.live.session_id, "gifts": {}, "purchases": []}
        self._save()
        self._publish()

    # ------------------------------------------------------------------ view
    def view(self) -> dict[str, Any]:
        n = self.c.scene.board_size
        gifts = sorted(self.data["gifts"].values(), key=lambda g: (g["coins"], g["gifts"], g.get("last", 0)),
                       reverse=True)
        buyers: dict[str, dict[str, Any]] = {}
        for p in self.data["purchases"]:
            b = buyers.setdefault(p["key"], {"name": p["name"], "items": 0, "amount": 0, "orders": 0})
            b["name"] = p["name"]
            b["items"] += p["qty"]
            b["amount"] += p["amount"]
            b["orders"] += 1
        top_buyers = sorted(buyers.values(), key=lambda b: (b["amount"], b["items"]), reverse=True)
        return {
            "gifts": [{"name": g["name"], "gifts": g["gifts"], "coins": g["coins"]} for g in gifts[:n]],
            "buyers": top_buyers[:n],
            "recent_purchases": list(reversed(self.data["purchases"][-20:])),
            "scope": self.c.scene.board_scope,
            "total_gifts": sum(g["gifts"] for g in self.data["gifts"].values()),
            "total_orders": len(self.data["purchases"]),
        }
