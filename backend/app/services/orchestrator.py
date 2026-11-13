"""Event Orchestrator: consumes the bus and routes each event (SPEC D)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter, deque
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.events.schema import EventType, LiveEvent
from app.models import LiveEventRow, Viewer
from app.services.camera_director import PRIORITY_GIFT
from app.services.intent_router import IntentKind

if TYPE_CHECKING:
    from app.container import AppContainer

log = logging.getLogger("chibi.orchestrator")


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

    async def run(self) -> None:
        while True:
            ev = await self.c.bus.get()
            try:
                await self.handle(ev)
            except Exception:  # noqa: BLE001 - one bad event must not stop the pipeline
                self.errors += 1
                log.exception("failed to handle event %s", ev.event_id)
            finally:
                self.c.bus.task_done()

    # ------------------------------------------------------------------ persistence
    def _persist_event(self, ev: LiveEvent) -> bool:
        safe = dict(ev.payload)
        if ev.user:
            safe["nickname"] = ev.user.nickname
            safe["unique_id"] = ev.user.unique_id
        try:
            with self.c.db.session() as s:
                s.add(LiveEventRow(
                    session_id=ev.session_id, provider=ev.provider, source_event_id=ev.event_id,
                    dedup_mode=ev.dedup_mode, platform_user_id=ev.user.identity_key if ev.user else None,
                    type=ev.type.value, safe_payload=safe, observed_at=ev.observed_at,
                ))
            return True
        except IntegrityError:
            return False  # duplicate at DB level (e.g. after reconnect) — drop silently

    def _upsert_viewer(self, ev: LiveEvent) -> None:
        if not ev.user or not ev.user.identity_key:
            return
        key = ev.user.identity_key
        with self.c.db.session() as s:
            v = s.execute(select(Viewer).where(Viewer.session_id == ev.session_id,
                                               Viewer.platform_user_id == key)).scalar_one_or_none()
            nickname = ev.user.nickname or ev.user.unique_id or "?"
            if v is None:
                s.add(Viewer(session_id=ev.session_id, platform_user_id=key, unique_id=ev.user.unique_id,
                             nickname=nickname))
            else:
                v.nickname = nickname
                v.last_seen_at = datetime.now(UTC)

    # ------------------------------------------------------------------ routing
    async def handle(self, ev: LiveEvent) -> None:
        if ev.session_id != self.c.live.session_id:
            return  # stale event from a previous session
        if not await asyncio.to_thread(self._persist_event, ev):
            return
        self.counts[ev.type.value] += 1
        is_demo = ev.capability == "simulated"
        if ev.type == EventType.COMMENT:
            await asyncio.to_thread(self._upsert_viewer, ev)
            self._comment(ev, is_demo)
        elif ev.type == EventType.JOIN:
            av = self.c.avatars.get_or_create(ev.user, is_demo)
            if av:
                await asyncio.to_thread(self._upsert_viewer, ev)
                self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": "wave", "avatar_id": av.avatar_id})
        elif ev.type == EventType.GIFT:
            n = self.c.gifts.settle(ev)
            if n:
                av = self.c.avatars.get_or_create(ev.user, is_demo)
                if av:
                    self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": "gift", "avatar_id": av.avatar_id,
                                          "count": n, "gift_name": ev.payload.get("gift_name")})
                    self.c.camera.request(av.avatar_id, None, PRIORITY_GIFT, max_seconds=3.0)
        elif ev.type in (EventType.LIKE, EventType.FOLLOW, EventType.SHARE):
            av = self.c.avatars.find(ev.user)  # like/follow never create avatars (LIVE-04)
            self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": ev.type.value.lower(),
                                  "avatar_id": av.avatar_id if av and av.visible else None})
        elif ev.type == EventType.VIEWER_COUNT:
            self.viewer_count = int(ev.payload.get("count", 0))

    def _comment(self, ev: LiveEvent, is_demo: bool) -> None:
        now = time.monotonic()
        self.comment_times.append(now)
        text = ev.payload["text"]
        intent = self.c.router.route(text)
        self.intent_counts[intent.kind.value] += 1
        av = self.c.avatars.get_or_create(ev.user, is_demo)
        outcome = None
        command_id = None
        if intent.moves_chibi and av:
            self.product_counts[intent.product_id] += 1
            cmd, outcome = self.c.actions.submit(
                av.avatar_id, av.viewer_key, intent.product_id,
                parent_event_id=ev.event_id, received_monotonic=ev.received_monotonic,
            )
            command_id = cmd.command_id if cmd else None
        elif av and intent.kind == IntentKind.GREETING:
            self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": "wave", "avatar_id": av.avatar_id})
        elif av and intent.kind == IntentKind.DANCE:
            self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": "dance", "avatar_id": av.avatar_id})

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
        self.c.hub.send_dashboard({"type": "COMMENT", "comment": record})
        if intent.needs_host or outcome == "no_location":
            item = {**record, "status": "Chưa được trả lời",
                    "suggestion": None, "suggestion_label": None,
                    "hint": self._host_hint(intent.kind, outcome, record)}
            self.host_attention.append(item)
            self.c.hub.send_dashboard({"type": "HOST_ATTENTION", "item": item})

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
