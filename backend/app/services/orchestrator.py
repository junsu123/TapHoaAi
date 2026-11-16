"""Event Orchestrator: consumes the bus and routes each event (SPEC D)."""

from __future__ import annotations

import logging
import time
from collections import Counter, deque
from typing import TYPE_CHECKING, Any

from app.events.schema import EventType, LiveEvent
from app.services.camera_director import PRIORITY_GIFT
from app.services.health import TokenBucket
from app.services.intent_router import IntentKind

if TYPE_CHECKING:
    from app.container import AppContainer

log = logging.getLogger("chibi.orchestrator")


DIRECT_WINDOW_S = 4.0  # the same direct command again within this window does nothing (spec §4)
LIKE_WINDOW_S = 8.0
DASH_CHAT_PER_S = 12.0
JOIN_WAVE_S = 60.0  # re-joining (TikTok sends join again after a reconnect) waves at most once a minute
DIRECT_EFFECTS = {
    IntentKind.GREETING: "wave", IntentKind.DANCE: "dance", IntentKind.EXPLORE: "explore",
    IntentKind.SIT: "sit", IntentKind.POSE: "pose",
}


class Orchestrator:
    def __init__(self, c: AppContainer):
        self.c = c
        self.counts: Counter[str] = Counter()
        self.intent_counts: Counter[str] = Counter()
        self.product_counts: Counter[str] = Counter()
        self.comment_times: deque[float] = deque(maxlen=5000)
        self.recent_comments: deque[dict[str, Any]] = deque(maxlen=200)
        self.host_attention: deque[dict[str, Any]] = deque(maxlen=100)
        self.viewer_count: int | None = None
        self.errors = 0
        self._last_effect: dict[tuple[str, str], float] = {}
        self._viewer_seen: dict[str, tuple[float, str]] = {}
        # the host page: every command / question / problem, but ordinary chat at most
        # DASH_CHAT_PER_S (nobody can read 300 comments a second); the rest is counted
        self._dash_chat = TokenBucket(DASH_CHAT_PER_S, DASH_CHAT_PER_S * 2)
        self.dash_skipped = 0
        self._dash_skipped_sent = 0.0

    async def run(self) -> None:
        while True:
            ev = await self.c.bus.get()
            try:
                await self.handle(ev)
            except Exception:
                self.errors += 1
                log.exception("failed to handle event %s", ev.event_id)
            finally:
                self.c.bus.task_done()
                self.c.health.event_handled(ev.received_monotonic)

    # ------------------------------------------------------------------ persistence
    # Written in batches by DbWriter (a few times a second, one transaction): the pipeline never
    # waits for the disk. Likes and viewer counts come in floods and are only counted, not stored
    # one by one. Duplicates are caught by the in-memory deduper; the unique index ignores the rest.
    NOT_STORED = (EventType.LIKE, EventType.VIEWER_COUNT)
    VIEWER_TOUCH_S = 30.0

    def _persist_event(self, ev: LiveEvent) -> None:
        if ev.type in self.NOT_STORED:
            return
        safe = dict(ev.payload)
        if ev.user:
            safe["nickname"] = ev.user.nickname
            safe["unique_id"] = ev.user.unique_id
        self.c.writer.add_event({
            "session_id": ev.session_id, "provider": ev.provider, "source_event_id": ev.event_id,
            "dedup_mode": ev.dedup_mode, "platform_user_id": ev.user.identity_key if ev.user else None,
            "type": ev.type.value, "safe_payload": safe, "observed_at": ev.observed_at,
        })

    def _upsert_viewer(self, ev: LiveEvent) -> None:
        if not ev.user or not ev.user.identity_key:
            return
        key = ev.user.identity_key
        now = time.monotonic()
        nickname = ev.user.nickname or ev.user.unique_id or "?"
        last = self._viewer_seen.get(key)
        if last and now - last[0] < self.VIEWER_TOUCH_S and last[1] == nickname:
            return  # written recently with the same name
        self._viewer_seen[key] = (now, nickname)
        if len(self._viewer_seen) > 50_000:
            self._viewer_seen.clear()
        self.c.writer.touch_viewer(ev.session_id, key, ev.user.unique_id, nickname)

    # ------------------------------------------------------------------ routing
    async def handle(self, ev: LiveEvent) -> None:
        if ev.session_id != self.c.live.session_id:
            return  # stale event from a previous session
        self._persist_event(ev)
        self.counts[ev.type.value] += 1
        if ev.type != EventType.VIEWER_COUNT:
            self.c.levels.seen(ev.user)  # still watching (Chibi levels)
        is_demo = ev.capability == "simulated"
        if ev.type == EventType.COMMENT:
            self._upsert_viewer(ev)
            self._comment(ev, is_demo)
        elif ev.type == EventType.JOIN:
            av = self.c.avatars.get_or_create(ev.user, is_demo, reason="join")
            if av:
                self._upsert_viewer(ev)
                if av.visible and self._allow(av.avatar_id, "join_wave", JOIN_WAVE_S):
                    self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": "wave", "avatar_id": av.avatar_id})
            if ev.user:  # greet everyone who joins, with or without a Chibi on screen
                self.c.assistant.on_join(ev.user.nickname or ev.user.unique_id, ev.user.identity_key)
                self.c.owner.on_join(ev.user.nickname or ev.user.unique_id, ev.user.identity_key)
        elif ev.type == EventType.GIFT:
            n = self.c.gifts.settle(ev)
            if n:
                av = self.c.avatars.get_or_create(ev.user, is_demo, reason="gift")
                name = (ev.user.nickname or ev.user.unique_id) if ev.user else None
                if av:
                    self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": "gift", "avatar_id": av.avatar_id,
                                          "count": n, "gift_name": ev.payload.get("gift_name")})
                    self.c.camera.request(av.avatar_id, None, PRIORITY_GIFT, max_seconds=3.0)
                self.c.board.add_gift(ev.user.identity_key if ev.user else None, name, n,
                                      int(ev.payload.get("diamonds") or 0), ev.session_id, is_demo)
                self.c.owner.on_gift(av.avatar_id if av else None, name, ev.payload.get("gift_name"), n)
        elif ev.type in (EventType.LIKE, EventType.FOLLOW, EventType.SHARE):
            av = self.c.avatars.find(ev.user)  # like/follow never create avatars (LIVE-04)
            if av:
                self.c.avatars.touch(av.avatar_id)  # still here → not idle
            kind = ev.type.value.lower()
            # likes come in floods: one small heart per viewer per window (spec §3.6, §10)
            if av and av.visible and self._allow(av.avatar_id, kind, LIKE_WINDOW_S if kind == "like" else DIRECT_WINDOW_S):
                self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": kind, "avatar_id": av.avatar_id})
        elif ev.type == EventType.VIEWER_COUNT:
            self.viewer_count = int(ev.payload.get("count", 0))
            if not is_demo:
                self.c.avatars.viewer_cap = self.viewer_count
        elif ev.type == EventType.LIVE_END:
            for avatar_id in self.c.avatars.exit_all("live_end"):
                self.c.actions.cancel_avatar(avatar_id, "live_end")
            self.c.camera.forget_all()

    def _allow(self, avatar_id: str, kind: str, window: float) -> bool:
        """Debounce: the same reaction for the same Chibi at most once per `window` seconds."""
        now = time.monotonic()
        key = (avatar_id, kind)
        if now - self._last_effect.get(key, -1e9) < window:
            return False
        self._last_effect[key] = now
        if len(self._last_effect) > 20000:
            self._last_effect.clear()
        return True

    def _direct(self, avatar_id: str, kind: str) -> str:
        if not self._allow(avatar_id, kind, DIRECT_WINDOW_S):
            return "duplicate"
        self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": kind, "avatar_id": avatar_id})
        return "direct"

    def _comment(self, ev: LiveEvent, is_demo: bool) -> None:
        now = time.monotonic()
        self.comment_times.append(now)
        text = ev.payload["text"]
        intent = self.c.router.route(text)
        self.intent_counts[intent.kind.value] += 1
        av = self.c.avatars.get_or_create(ev.user, is_demo, reason="product" if intent.moves_chibi else "comment")
        outcome = None
        command_id = None
        game = None
        if self.c.games.active:
            gname = (ev.user.nickname or ev.user.unique_id or "bạn") if ev.user else "bạn"
            game = self.c.games.answer(ev.user, gname, text, av.avatar_id if av else None)
        if game:
            # a mini-game answer: counted, nothing else (not read aloud, no Chibi errand, no Claude)
            outcome = "game_" + game
            if av and game == "answer":
                self._direct(av.avatar_id, "think")
        elif intent.moves_chibi and av:
            self.product_counts[intent.product_id] += 1
            cmd, outcome = self.c.actions.submit(
                av.avatar_id, av.viewer_key, intent.product_id,
                parent_event_id=ev.event_id, received_monotonic=ev.received_monotonic,
            )
            command_id = cmd.command_id if cmd else None
            if outcome == "no_location":  # approved product that sits on no shelf
                self._direct(av.avatar_id, "surprise")
        elif av and intent.kind == IntentKind.LEAVE:
            # "về thôi": put things back, wave, walk out (spec LEAVE_WAVE); a later comment brings them back
            outcome = "leave"
            self.c.stage.remove(av.viewer_key)
            self.c.actions.cancel_avatar(av.avatar_id, "user_leave")
            self.c.camera.forget_avatar(av.avatar_id)
            self.c.avatars.leave(av.avatar_id)
        elif av and intent.kind == IntentKind.DANCE and self.c.scene.stage_enabled:
            # the dance stage: whoever comments first dances first
            name = (ev.user.nickname or ev.user.unique_id) if ev.user else "bạn"
            outcome = "stage_" + self.c.stage.register(ev.user, name, is_demo)
        elif av and intent.kind in DIRECT_EFFECTS:
            outcome = self._direct(av.avatar_id, DIRECT_EFFECTS[intent.kind])
        elif intent.kind in (IntentKind.POEM, IntentKind.STORY):
            name = (ev.user.nickname or ev.user.unique_id) if ev.user else None
            viewer = ev.user.identity_key if ev.user else None
            outcome = self.c.talk.request("poem" if intent.kind == IntentKind.POEM else "story", name, viewer)
        elif av and intent.kind == IntentKind.AMBIGUOUS:
            self._direct(av.avatar_id, "think")  # waits, a "?" over the head — never a random product
        elif av and intent.kind == IntentKind.QUESTION and intent.product_id is None:
            held = self.c.actions.current_product(av.avatar_id)
            if held:  # "thành phần trà này" → the box in this viewer's hands
                intent.product_id = held
                self._direct(av.avatar_id, "point")

        names = self.c.catalog.products
        record = {
            "event_id": ev.event_id, "at": ev.observed_at.isoformat(),
            "nickname": ev.user.nickname if ev.user else None,
            "unique_id": ev.user.unique_id if ev.user else None,
            "text": text, "intent": intent.kind.value, "product_id": intent.product_id,
            "product_name": names[intent.product_id].name if intent.product_id in names else None,
            "confidence": intent.confidence,
            "candidates": [{"product_id": p, "name": names[p].name if p in names else p, "score": round(s, 3)}
                           for p, s in intent.candidates[:4]],
            "avatar_id": av.avatar_id if av else None, "action_outcome": outcome, "command_id": command_id,
            "is_demo": is_demo,
        }
        self.recent_comments.append(record)
        important = (intent.moves_chibi or intent.needs_host or outcome in ("no_location", "leave")
                     or intent.kind in (IntentKind.QUESTION, IntentKind.AMBIGUOUS))
        if important or self._dash_chat.allow():
            self.c.hub.send_dashboard({"type": "COMMENT", "comment": record})
        else:
            self.dash_skipped += 1
            if now - self._dash_skipped_sent >= 1.0:
                self._dash_skipped_sent = now
                self.c.hub.send_dashboard({"type": "COMMENTS_SKIPPED", "total": self.dash_skipped})
        viewer_key = av.viewer_key if av else (ev.user.identity_key if ev.user else None)
        chat = (not game and not intent.needs_host and outcome != "no_location"
                and self.c.assistant.wants_chat(intent, viewer_key))
        if not game and (intent.needs_host or outcome == "no_location" or chat):
            item = {**record, "status": "Chưa được trả lời",
                    "suggestion": None, "suggestion_label": None, "chat": chat,
                    "hint": "Bình luận thường — tự động hoàn toàn: chỉ đọc khi có câu trả lời an toàn." if chat
                    else self._host_hint(intent.kind, outcome, record)}
            self.host_attention.append(item)
            self.c.assistant.on_comment(item, intent, viewer_key)
            self.c.hub.send_dashboard({"type": "HOST_ATTENTION", "item": item})
        else:  # greetings, product names, dance and ordinary chat: welcome / read aloud
            self.c.assistant.on_other(record, intent, viewer_key)

    @staticmethod
    def _host_hint(kind: IntentKind, outcome: str | None, record: dict[str, Any]) -> str:
        if outcome == "no_location":
            return "Sản phẩm đã duyệt nhưng chưa được gắn vào kệ nào."
        if kind == IntentKind.AMBIGUOUS:
            names = ", ".join(c["name"] for c in record["candidates"]) or "nhiều sản phẩm"
            return f"Bình luận mơ hồ ({names}). Hãy hỏi khách tên sản phẩm cụ thể."
        return "Câu hỏi của khách — người trực trả lời trực tiếp."

    def comments_per_second(self, window: float = 60.0) -> float:
        now = time.monotonic()
        n = sum(1 for t in self.comment_times if now - t <= window)
        return round(n / window, 3)
