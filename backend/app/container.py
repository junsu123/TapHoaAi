"""AppContainer: builds and wires every service once (no globals)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any

from cryptography.fernet import InvalidToken
from sqlalchemy import delete, select

from app.config import Settings
from app.db import Database
from app.events.bus import EventBus
from app.events.deduper import Deduper, GiftStreakTracker
from app.models import ActionJob, LiveEventRow, Setting
from app.security.crypto import SecretBox, load_or_create_key
from app.services.assistant import Assistant
from app.services.action_queue import CmdStatus, Command, GameActionQueue, TERMINAL
from app.services.avatar_manager import AvatarManager
from app.services.camera_director import CameraDirector
from app.services.catalog import build_catalog
from app.services.intent_router import CommentIntentRouter
from app.services.live_session import LiveSessionService
from app.services.orchestrator import Orchestrator
from app.services.product_matcher import ProductMatcher
from app.services.speech_queue import SpeechQueue
from app.websocket.hub import Hub

log = logging.getLogger("chibi")
TICK_SECONDS = 0.25


class AppContainer:
    def __init__(self, settings: Settings, db: Database | None = None, hub=None):
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        self.db = db or Database(settings.resolved_database_url)
        self.box = SecretBox(load_or_create_key(settings.data_dir))
        self.hub = hub or Hub()
        self.bus = EventBus(settings.bus_max_size)
        self.deduper = Deduper()
        self.gifts = GiftStreakTracker()
        self.catalog_version = 1
        self.catalog = build_catalog(self.db, self.catalog_version)
        self.matcher = ProductMatcher(self.catalog, settings.match_high_confidence,
                                      settings.match_suggest_floor, settings.match_ambiguity_margin)
        self.router = CommentIntentRouter(self.matcher)
        self.camera = CameraDirector(self.hub, settings.camera_min_hold_seconds)
        self.avatars = AvatarManager(self.hub, settings.max_visible_avatars, settings.avatar_idle_exit_seconds)
        self.actions = GameActionQueue(
            self.hub, self.catalog, self.camera, cooldown=settings.command_cooldown_seconds,
            max_pending=settings.max_pending_per_viewer, show_seconds=settings.show_seconds,
            reservation_ttl=settings.reservation_ttl_seconds, ack_timeout=settings.ack_timeout_seconds,
            action_timeout=settings.action_timeout_seconds, persist=self._persist_command,
        )
        self.avatars.is_busy = self.actions.is_busy
        saved_idle = self.get_setting("avatar_idle_exit_seconds")
        if saved_idle and saved_idle.isdigit():
            self.avatars.idle_exit_seconds = int(saved_idle)
        self.actions.is_avatar_visible = self._avatar_visible
        self.actions.on_update = lambda c: self.hub.send_dashboard({"type": "ACTION_UPDATE", "action": c.summary()})
        self.hub.on_primary_changed = self.actions.on_primary_changed
        self.live = LiveSessionService(self.db, self.bus, self.deduper, self._on_session_change, self._on_live_status)
        self.orchestrator = Orchestrator(self)
        self.ai_paused = False
        self.speech = SpeechQueue(self.hub, settings.data_dir / "tts_cache")
        self.assistant = Assistant(self)
        self.speech.on_chars = self.assistant.budget.record_tts
        self.assistant.apply_voice()
        self.fps_reports: deque[dict[str, Any]] = deque(maxlen=120)
        self.started_at = time.time()
        self.game_token = self._load_or_create_game_token()
        # TikTok client factory: None = the real TikTokLive client (tests inject a fake)
        self.tiktok_client_factory = None
        self._tasks: list[asyncio.Task] = []

    # ------------------------------------------------------------------ wiring helpers
    def _avatar_visible(self, avatar_id: str) -> bool:
        av = self.avatars.get(avatar_id)
        return av is not None and av.visible

    def _persist_command(self, cmd: Command) -> None:
        with self.db.session() as s:
            row = s.execute(select(ActionJob).where(ActionJob.command_id == cmd.command_id)).scalar_one_or_none()
            if row is None:
                row = ActionJob(command_id=cmd.command_id, session_id=cmd.session_id, viewer_key=cmd.viewer_key,
                                avatar_id=cmd.avatar_id, product_id=cmd.product_id, action=cmd.action,
                                priority=cmd.priority, parent_event_id=cmd.parent_event_id, status=cmd.status.value)
                s.add(row)
            row.status = cmd.status.value
            row.reason = cmd.reason
            row.shelf_code = cmd.shelf_code
            row.stand_index = cmd.stand_index

    def _on_session_change(self, session_id: str | None) -> None:
        for cmd in list(self.actions.commands.values()):
            if cmd.status not in TERMINAL:
                cmd.status = CmdStatus.CANCELLED
                cmd.reason = "session_ended"
                self._persist_command(cmd)
        self.avatars.reset(session_id)
        self.avatars.viewer_cap = None
        self.actions.reset(session_id)
        self.camera.current = None
        self.camera.queue.clear()
        self.hub.send_game({"type": "SESSION", "session_id": session_id, "is_demo": self.live.is_demo})

    def _on_live_status(self, status: dict[str, Any]) -> None:
        self.hub.send_dashboard({"type": "LIVE_STATUS", "status": status})
        self.hub.send_game({"type": "LIVE_STATUS", "status": status["status"], "is_demo": status["is_demo"]})

    def _load_or_create_game_token(self) -> str:
        with self.db.session() as s:
            row = s.get(Setting, "game_token")
            if row:
                try:
                    return self.box.decrypt(row.encrypted_value)
                except InvalidToken:
                    # DB restored on a machine with a different secret.key: issue a new token
                    log.warning("game token could not be decrypted (different secret.key); regenerating")
            token = secrets.token_urlsafe(18)
            if row:
                row.encrypted_value = self.box.encrypt(token)
            else:
                s.add(Setting(key="game_token", encrypted_value=self.box.encrypt(token), is_secret=True))
            return token

    # ------------------------------------------------------------------ settings
    def get_setting(self, key: str) -> str | None:
        with self.db.session() as s:
            row = s.get(Setting, key)
            if not row:
                return None
            try:
                return self.box.decrypt(row.encrypted_value)
            except InvalidToken:
                return None

    def set_setting(self, key: str, value: str | None, *, secret: bool) -> None:
        with self.db.session() as s:
            row = s.get(Setting, key)
            if value in (None, ""):
                if row:
                    s.delete(row)
                return
            enc = self.box.encrypt(value)
            if row:
                row.encrypted_value = enc
                row.is_secret = secret
                row.updated_at = datetime.now(UTC)
            else:
                s.add(Setting(key=key, encrypted_value=enc, is_secret=secret))

    # ------------------------------------------------------------------ catalog
    def reload_catalog(self) -> None:
        self.catalog_version += 1
        self.catalog = build_catalog(self.db, self.catalog_version)
        self.matcher.catalog = self.catalog
        self.actions.set_catalog(self.catalog)
        self.hub.send_game({"type": "LAYOUT_UPDATED", "layout": self.catalog.layout_dict()})

    # ------------------------------------------------------------------ snapshot
    def game_snapshot(self) -> dict[str, Any]:
        return {
            "type": "SNAPSHOT", "schema_version": 1, "sequence": self.hub.game.sequence,
            "session_id": self.live.session_id, "live_status": self.live.status.value,
            "is_demo": self.live.is_demo, "layout": self.catalog.layout_dict(),
            "avatars": [a.to_dict() for a in self.avatars.visible()],
            "active_commands": [c.wire() for c in self.actions.active_commands()],
            "camera": self.camera.snapshot(),
            "settings": {"show_seconds": self.settings.show_seconds},
        }

    def dashboard_snapshot(self) -> dict[str, Any]:
        return {
            "type": "SNAPSHOT", "schema_version": 1, "sequence": self.hub.dashboard.sequence,
            "live": self.live.status_dict(), "comments": list(self.orchestrator.recent_comments)[-50:],
            "host_attention": list(self.orchestrator.host_attention)[-30:], "ai_paused": self.ai_paused,
            "speech": self.speech.state(), "ai": self.assistant.status(),
        }

    # ------------------------------------------------------------------ metrics
    def metrics(self) -> dict[str, Any]:
        fps = [r["fps"] for r in self.fps_reports if isinstance(r.get("fps"), (int, float))]
        return {
            "uptime_s": round(time.time() - self.started_at),
            "live": {"status": self.live.status.value, "is_demo": self.live.is_demo,
                     "session_id": self.live.session_id},
            "events": dict(self.orchestrator.counts),
            "intents": dict(self.orchestrator.intent_counts),
            "top_products": self.orchestrator.product_counts.most_common(5),
            "comments_per_s": self.orchestrator.comments_per_second(),
            "avatars": {"total": self.avatars.count, "visible": len(self.avatars.visible()),
                        "overflow": len(self.avatars.overflow)},
            "actions": {"queue_depth": self.actions.queue_depth(), "completed": self.actions.completed,
                        "failed": self.actions.failed, "latency": self.actions.latency_stats()},
            "bus": {"depth": self.bus.depth, "dropped_low_priority": self.bus.dropped_low_priority,
                    "duplicates_dropped": self.deduper.dropped},
            "viewer_count": self.orchestrator.viewer_count,  # None = provider does not report it
            "game_clients": {"connected": len(self.hub.game.clients), "primary": self.hub.has_primary()},
            "game_fps": {"last": fps[-1] if fps else None, "min_last_2min": min(fps) if fps else None},
            "gifts_total": self.gifts.total_gifts,
            "ai": self.assistant.status(),
            "speech": {"muted": self.speech.muted, "hold": self.speech.hold, "queue": len(self.speech.queue)},
            "errors": self.orchestrator.errors,
        }

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        self._cancel_stale_commands()
        self.hub.start()
        self.speech.start()
        self._tasks = [
            asyncio.create_task(self.orchestrator.run(), name="orchestrator"),
            asyncio.create_task(self._ticker(), name="ticker"),
            asyncio.create_task(self._dashboard_metrics(), name="metrics"),
            asyncio.create_task(self._retention(), name="retention"),
        ]

    async def stop(self) -> None:
        await self.live.stop()
        await self.speech.stop()
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await t
        await self.hub.stop()

    def _cancel_stale_commands(self) -> None:
        with self.db.session() as s:
            rows = s.execute(select(ActionJob).where(ActionJob.status.notin_([x.value for x in TERMINAL]))).scalars()
            for r in rows:
                r.status = CmdStatus.CANCELLED.value
                r.reason = "restart"

    async def _ticker(self) -> None:
        while True:
            try:
                self.actions.tick()
                self.avatars.tick()
                self.camera.tick()
            except Exception:  # noqa: BLE001
                log.exception("tick failed")
            await asyncio.sleep(TICK_SECONDS)

    async def _dashboard_metrics(self) -> None:
        while True:
            await asyncio.sleep(2.0)
            if self.hub.dashboard.clients:
                self.hub.send_dashboard({"type": "METRICS", "metrics": self.metrics()})

    async def _retention(self) -> None:
        while True:
            try:
                cutoff = datetime.now(UTC) - timedelta(days=self.settings.event_retention_days)
                with self.db.session() as s:
                    s.execute(delete(LiveEventRow).where(LiveEventRow.observed_at < cutoff))
            except Exception:  # noqa: BLE001
                log.exception("retention cleanup failed")
            await asyncio.sleep(3600)
