"""Question desk (AI-02…AI-06, HOST-01/02): a viewer's question → read aloud → Claude draft →
host approves (or, in auto mode, safe drafts are read at once).

Rules first: only comments the router marks QUESTION/AMBIGUOUS reach here, product-name comments
never cost an API call. Duplicates within two minutes share one answer, drafts are cached, every
call must fit the budget, and when anything is missing (no key, budget used up, AI paused, Claude
down) the game keeps running and the host still sees the question, with a catalog-only template
answer when one applies."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import deque
from typing import TYPE_CHECKING, Any

from app.models import AiMessage, ConversationTurn
from app.services.ai_config import (
    SECRET_CLAUDE_KEY,
    SECRET_VBEE_APP_ID,
    SECRET_VBEE_TOKEN,
    AiConfig,
    load_config,
    save_config,
)
from app.services.answer_memory import AnswerMemory
from app.services.budget_guard import BudgetGuard
from app.services.claude_service import (
    AnthropicClient,
    ClaudeClient,
    ClaudeError,
    Completion,
    Draft,
    answer_schema,
    catalog_context,
    check_draft,
    system_prompt,
    template_reply,
)
from app.services.intent_router import Intent, IntentKind
from app.services.text_safety import (
    contains_banned,
    format_vnd,
    sanitize_comment,
    scrub_pii,
    speakable_name,
)
from app.services.tts_vbee import FakeTts, VbeeTts
from app.text_norm import fold

if TYPE_CHECKING:
    from app.container import AppContainer

log = logging.getLogger("chibi.ai")

DUPLICATE_WINDOW_S = 120.0
CACHE_TTL_S = 30 * 60
VIEWER_READ_GAP_S = 20.0  # one viewer's questions are read aloud at most this often
# "Tự động hoàn toàn": how often each kind of non-question comment may be answered out loud
GREET_GAP_S = 12.0
PRODUCT_GAP_S = 8.0
SAME_PRODUCT_GAP_S = 45.0
CHAT_GAP_S = 15.0
VIEWER_SOCIAL_GAP_S = 60.0  # one viewer is greeted/answered for small talk at most once a minute
WELCOME_AGAIN_S = 600.0  # someone who leaves and comes back within 10 minutes is not greeted twice
WELCOME_GATHER_S = 2.0  # wait this long for others joining at the same moment, to greet them together
WELCOME_FOLD_S = 60.0  # names waiting longer than this (huge crowd) are greeted as "và N bạn khác"
COMMENT_TTL_S = 30.0  # a comment not read within 30 s is dropped: reading old chat is noise
COMMENT_VIEWER_GAP_S = 8.0  # one viewer's comments are read at most this often (spam)
MAX_ITEMS = 200

ST_NEW = "Chưa được trả lời"
ST_DRAFTING = "AI đang soạn…"
ST_SUGGESTED = "AI đề xuất"
ST_REVIEW = "Cần người trực xem"
ST_CONFIRMED = "Người trực đã xác nhận"
ST_AUTO = "Đã đọc tự động"
ST_DISMISSED = "Đã bỏ qua"
ST_DUPLICATE = "Trùng câu hỏi"
ST_SIMPLE = "Đã trả lời tự động"

SOURCE_LABEL = {"claude": "AI đề xuất", "cache": "AI đề xuất (dùng lại)", "template": "Câu mẫu từ danh mục",
                "memory": "Câu đã học (không gọi Claude)"}


class FakeClaude:
    """Offline stand-in (CHIBI_FAKE_AI=1) answering from the catalog in the user message."""

    async def complete(self, *, api_key: str, model: str, system: str, user: str, schema: dict[str, Any],
                       max_tokens: int) -> Completion:
        await asyncio.sleep(0.05)
        enum = schema["properties"]["product_id"]["anyOf"][0]["enum"]
        hint = user.split("<goi_y_san_pham>")[-1].split("</goi_y_san_pham>")[0].strip() if "<goi_y_san_pham>" in user else ""
        pid = hint if hint in enum else None
        price = None
        if pid:
            for line in user.splitlines():
                if f'"ma": "{pid}"' in line:
                    price = json.loads(line).get("gia")
        if pid and price:
            out = {"intent": "PRICE", "product_id": pid, "confidence": 0.95,
                   "suggested_reply": f"Dạ sản phẩm này giá {price} ạ, bạn bấm giỏ hàng để đặt nhé.",
                   "needs_human_review": False}
        else:
            out = {"intent": "OTHER", "product_id": None, "confidence": 0.4,
                   "suggested_reply": "Dạ shop kiểm tra và trả lời bạn ngay ạ.", "needs_human_review": True}
        return Completion(json.dumps(out, ensure_ascii=False), 900, 60)


class Assistant:
    def __init__(self, c: AppContainer):
        self.c = c
        self.fake = c.settings.fake_ai
        self.client: ClaudeClient = FakeClaude() if self.fake else AnthropicClient()
        self.budget = BudgetGuard(c.db, alert=self._alert)
        self.memory = AnswerMemory(c.db)
        self._cfg: AiConfig | None = None
        self.items: dict[str, dict[str, Any]] = {}
        self._recent_q: dict[tuple[str, str | None], tuple[str, float]] = {}
        self._cache: dict[tuple[str, str | None, int, str], tuple[Draft, float]] = {}
        self._viewer_read: dict[str, float] = {}
        self._kind_last: dict[str, float] = {}
        self._product_last: dict[str, float] = {}
        self._viewer_social: dict[str, float] = {}
        self._greet_i = 0
        self._welcome_pending: list[tuple[str, str | None, float]] = []  # (name, viewer_key, joined_at)
        self._welcomed: dict[str, float] = {}
        self._welcome_clip = None
        self._welcome_task: asyncio.Task | None = None
        self._comment_last: dict[str, tuple[float, str]] = {}
        self._sem = asyncio.Semaphore(2)
        self._tasks: set[asyncio.Task] = set()
        self.last_error: str | None = None
        # why each join / comment was or was not put on the LIVE (shown on the host page)
        self.trace: deque[dict[str, Any]] = deque(maxlen=40)
        self._checks_sent: str = ""

    # ------------------------------------------------------------------ configuration
    @property
    def config(self) -> AiConfig:
        if self._cfg is None:
            self._cfg = load_config(self.c)
        return self._cfg

    def update_config(self, cfg: AiConfig) -> None:
        save_config(self.c, cfg)
        self._cfg = cfg
        self.apply_voice()

    def api_key(self) -> str | None:
        return "fake-key" if self.fake else self.c.get_setting(SECRET_CLAUDE_KEY)

    def _trace(self, kind: str, who: str | None, text: str | None, ok: bool, reason: str) -> None:
        entry = {"at": time.time(), "kind": kind, "who": (who or "")[:60], "text": (text or "")[:120],
                 "ok": ok, "reason": reason}
        self.trace.append(entry)
        self.c.hub.send_dashboard({"type": "VOICE_TRACE", "entry": entry})

    def apply_voice(self) -> None:
        sq = self.c.speech
        cfg = self.config
        sq.voice, sq.speed = cfg.voice_code, cfg.voice_speed
        sq.tts_ok = self.tts_ok
        sq.fallback = ({"name": cfg.browser_voice_name or None, "rate": cfg.browser_voice_rate, "lang": "vi-VN"}
                       if cfg.browser_voice else None)
        sq.on_player_info = self.publish_status
        if self.fake:
            sq.provider = FakeTts()
        else:
            app_id, token = self.c.get_setting(SECRET_VBEE_APP_ID), self.c.get_setting(SECRET_VBEE_TOKEN)
            sq.provider = VbeeTts(app_id, token) if app_id and token else None

    def voice_ready(self) -> tuple[bool, str]:
        """May the assistant put something on the LIVE (voice, or a caption when there is no voice)?"""
        cfg = self.config
        if not cfg.voice_enabled or not cfg.voice_policy_confirmed:
            return False, "Phát trên LIVE đang tắt."
        if self.c.ai_paused:
            return False, "AI đang tạm dừng."
        if self.c.speech.muted:
            return False, "Giọng đã bị tắt bằng nút khẩn cấp."
        return True, ""

    def audio_note(self) -> str | None:
        """Why clips will be captions only (no sound), if they will."""
        cfg = self.config
        if self.c.settings.tts_locked:
            return "Giọng đọc bị khóa bằng CHIBI_TTS_LOCKED — chỉ hiện phụ đề."
        if self.c.speech.provider is None:
            return "Chưa nhập App ID/Token Vbee — chỉ hiện phụ đề."
        if not self.budget.tts_allows(1, cfg.voice_month_chars):
            return "Hết hạn mức ký tự giọng đọc của tháng — chỉ hiện phụ đề."
        if time.monotonic() < self.c.speech.tts_down_until:
            return self.c.speech.tts_down_reason
        return None

    def tts_ok(self, chars: int) -> bool:
        return not self.c.settings.tts_locked and self.budget.tts_allows(chars, self.config.voice_month_chars)

    def checks(self) -> list[dict[str, Any]]:
        """Everything that must be right for viewers to be greeted and comments read, with how to fix it."""
        cfg = self.config
        sq = self.c.speech
        info = sq.player_info if self.c.hub.has_primary() else {}
        player = self.c.hub.has_primary()
        vbee = sq.provider is not None and time.monotonic() >= sq.tts_down_until and not self.c.settings.tts_locked
        vi = [v["name"] for v in info.get("voices", []) if str(v.get("lang", "")).lower().startswith("vi")]
        if vbee:
            audio_ok, audio = True, "Có tiếng: giọng Vbee."
        elif cfg.browser_voice and info.get("fallback_voice"):
            audio_ok, audio = True, f"Có tiếng: giọng có sẵn của máy — {info['fallback_voice']}."
        elif cfg.browser_voice and player and info.get("speech_api") and not vi:
            audio_ok, audio = False, ("Không có tiếng: máy phát LIVE chưa có giọng đọc tiếng Việt và chưa có Vbee — "
                                      "chỉ hiện phụ đề. Windows: Cài đặt → Thời gian & ngôn ngữ → Giọng nói → "
                                      "Thêm giọng nói → Tiếng Việt, rồi mở lại OBS; hoặc nhập Vbee.")
        elif cfg.browser_voice and player and info and not info.get("speech_api"):
            audio_ok, audio = False, ("Không có tiếng: trình duyệt của OBS không hỗ trợ giọng có sẵn và chưa có Vbee — "
                                      "chỉ hiện phụ đề. Hãy nhập Vbee (Trợ lý AI & giọng đọc).")
        elif not cfg.browser_voice:
            audio_ok, audio = False, ("Không có tiếng: chưa có Vbee và đã tắt “giọng có sẵn của máy” — chỉ hiện phụ đề.")
        else:
            audio_ok, audio = False, "Chưa biết: mở trang game (OBS) để kiểm tra giọng đọc của máy."
        if sq.tts_down_reason and time.monotonic() < sq.tts_down_until:
            audio += f" (Vbee đang lỗi: {sq.tts_down_reason})"
        return [
            {"id": "voice", "ok": cfg.voice_enabled and cfg.voice_policy_confirmed,
             "label": "Bật phát trên LIVE",
             "fix": "Trang Trợ lý AI & giọng đọc → đánh dấu 4 ô chính sách → bật “Bật phát trên LIVE” → Lưu."},
            {"id": "paused", "ok": not self.c.ai_paused, "label": "AI không tạm dừng",
             "fix": "Bấm “▶ Chạy lại AI” (Ctrl+Shift+P)."},
            {"id": "muted", "ok": not sq.muted, "label": "Giọng không bị tắt khẩn cấp", "fix": "Bấm “🔊 Bật lại giọng”."},
            {"id": "player", "ok": player, "label": "Trang game (OBS) đang mở",
             "fix": "Mở /game/live trong OBS (Browser Source) hoặc một tab trình duyệt trên máy phát LIVE. "
                    "Lời chào/bình luận chỉ được đọc trên trang này."},
            {"id": "blocked", "ok": not info.get("blocked"), "label": "Trang game được phép phát tiếng",
             "fix": "Trang game mở bằng trình duyệt thường đang chặn âm thanh: bấm “🔈 Bấm để bật âm thanh” trên trang đó "
                    "(OBS không cần)."},
            {"id": "greet", "ok": cfg.greet_joins, "label": "Chào người vào xem",
             "fix": "Trang Trợ lý AI & giọng đọc → thẻ 👋 → bật “Chào người vào xem”."},
            {"id": "read", "ok": cfg.read_comments, "label": "Đọc bình luận",
             "fix": "Trang Trợ lý AI & giọng đọc → thẻ 👋 → bật “Đọc bình luận”."},
            {"id": "audio", "ok": audio_ok, "label": "Âm thanh", "detail": audio, "fix": ""},
        ]

    def publish_status(self) -> None:
        self.c.hub.send_dashboard({"type": "AI_STATUS", "ai": self.status()})

    def refresh_checks(self) -> None:
        """Called every few seconds: push the checklist when it changes (OBS page opened/closed…)."""
        key = json.dumps(self.checks(), sort_keys=True)
        if key != self._checks_sent:
            self._checks_sent = key
            self.publish_status()

    def status(self) -> dict[str, Any]:
        cfg = self.config
        ok, why = self.voice_ready()
        return {"configured": bool(self.api_key()), "model": cfg.model, "paused": self.c.ai_paused,
                "budget": self.budget.status(cfg.budget_day_usd, cfg.budget_month_usd, cfg.voice_month_chars),
                "voice_ready": ok, "voice_reason": why, "answer_mode": cfg.answer_mode, "autopilot": cfg.autopilot,
                "audio_note": self.audio_note() if ok else None, "greet_joins": cfg.greet_joins,
                "read_comments": cfg.read_comments, "checks": self.checks(),
                "last_error": self.last_error, "fake": self.fake}

    def _alert(self, code: str, info: dict[str, Any]) -> None:
        msg = {"AI_SPEND_70_PERCENT": "Chi phí AI đã dùng 70 %", "AI_SPEND_90_PERCENT": "Chi phí AI đã dùng 90 %",
               "AI_BUDGET_EXHAUSTED": "Đã hết hạn mức chi phí AI — chuyển sang câu mẫu"}[code]
        self.c.hub.send_dashboard({"type": "ALERT", "code": code,
                                   "message": f"{msg} {info['period']} ({info['spent_usd']}/{info['cap_usd']} USD)."})

    # ------------------------------------------------------------------ item updates
    def _update(self, item: dict[str, Any], **changes: Any) -> None:
        item.update(changes)
        self._persist(item)
        self.c.hub.send_dashboard({"type": "HOST_ATTENTION_UPDATE", "item": item})

    # ------------------------------------------------------------------ conversation log
    def _persist(self, item: dict[str, Any]) -> None:
        """Mirror the item into conversation_turns (one row per question, upserted)."""
        try:
            with self.c.db.session() as s:
                row = s.query(ConversationTurn).filter_by(event_id=item["event_id"]).one_or_none()
                if row is None:
                    row = ConversationTurn(event_id=item["event_id"], session_id=self.c.live.session_id,
                                           is_demo=bool(item.get("is_demo")), nickname=item.get("nickname"),
                                           question=scrub_pii(item["text"]) or "(trống)", intent=item.get("intent"),
                                           product_id=item.get("product_id"), status=item.get("status") or ST_NEW)
                    s.add(row)
                row.status = item.get("status") or row.status
                if item.get("suggestion") and not row.draft:
                    row.draft = item["suggestion"]
                    row.draft_source = item.get("draft_source")
                if item.get("final_answer"):
                    row.answer = item["final_answer"]
                    row.answered_by = item.get("answered_by")
                row.spoken = bool(item.get("spoken"))
                row.knowledge_id = item.get("knowledge_id") or row.knowledge_id
                row.cost_usd = float(item.get("cost_usd") or row.cost_usd or 0.0)
        except Exception:
            log.exception("Không ghi được lịch sử hội thoại")

    def _learn(self, item: dict[str, Any], answer: str, *, trusted: bool, source: str) -> None:
        cfg = self.config
        if not cfg.learn_enabled:
            return
        catalog = self.c.catalog

        def job() -> None:
            kid = self.memory.learn(scrub_pii(item["text"]), item.get("product_id"), item.get("ai_intent"), answer,
                                    trusted=trusted, source=source, catalog=catalog, threshold=cfg.memory_threshold)
            if kid:
                item["knowledge_id"] = kid
                self._persist(item)

        self._spawn(asyncio.to_thread(job))

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        """Tests: wait for every background job."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # ------------------------------------------------------------------ entry point (sync, from the orchestrator)
    def on_comment(self, item: dict[str, Any], intent: Intent, viewer_key: str | None) -> None:
        if intent.kind not in (IntentKind.QUESTION, IntentKind.AMBIGUOUS) and not item.get("chat"):
            return
        self.items[item["event_id"]] = item
        while len(self.items) > MAX_ITEMS:
            self.items.pop(next(iter(self.items)))
        item.setdefault("suggestion", None)
        item.setdefault("review_reasons", [])
        item["product_id"] = intent.product_id
        if self.c.ai_paused:
            item["hint"] = item.get("hint", "") + " (AI đang tạm dừng)"
            self._persist(item)
            return
        now = time.monotonic()
        key = (" ".join(fold(item["text"]).split()), intent.product_id)
        first = self._recent_q.get(key)
        if first and now - first[1] < DUPLICATE_WINDOW_S and first[0] in self.items:
            orig = self.items[first[0]]
            item.update(status=ST_DUPLICATE, duplicate_of=first[0], suggestion=orig.get("suggestion"),
                        hint="Câu hỏi giống hệt vừa có — dùng chung câu trả lời bên trên.")
            self._persist(item)
            return
        self._recent_q[key] = (item["event_id"], now)
        self._recent_q = {k: v for k, v in self._recent_q.items() if now - v[1] < DUPLICATE_WINDOW_S}

        if intent.kind == IntentKind.QUESTION:
            self._read_question(item, viewer_key, now)
        elif intent.kind == IntentKind.AMBIGUOUS or item.get("chat"):
            self.read_comment(item, viewer_key, now, as_question=False)
        item["viewer_key"] = viewer_key
        self._persist(item)
        self._spawn(self._draft_and_maybe_speak(item, intent))

    def _read_question(self, item: dict[str, Any], viewer_key: str | None, now: float) -> None:
        self.read_comment(item, viewer_key, now, as_question=True)

    def read_comment(self, item: dict[str, Any], viewer_key: str | None, now: float, *, as_question: bool) -> bool:
        """Read a viewer's comment aloud ("Bạn Lan hỏi: …" / "Bạn Lan nói: …"). Questions are always
        kept; other comments wait at most 30 s and are skipped when many lines are already waiting."""
        cfg = self.config
        who = item.get("nickname") or item.get("unique_id")
        kind = "question" if as_question else "comment"

        def no(reason: str) -> bool:
            self._trace(kind, who, item.get("text"), False, reason)
            return False

        ok, why = self.voice_ready()
        if not ok:
            return no(why)
        if not (cfg.read_questions if as_question else cfg.read_comments):
            return no("Đã tắt “Đọc câu hỏi”." if as_question else "Đã tắt “Đọc bình luận”.")
        safe = sanitize_comment(item["text"], cfg.banned_words)
        if safe is None:
            item["review_reasons"] = [*item.get("review_reasons", []), "Không đọc to: có từ cấm hoặc toàn liên kết/số"]
            return no("Có từ cấm, hoặc chỉ toàn liên kết/số điện thoại/biểu tượng.")
        if as_question:
            if viewer_key and now - self._viewer_read.get(viewer_key, -1e9) < VIEWER_READ_GAP_S:
                return no("Người này vừa được đọc câu hỏi (cách nhau ít nhất 20 giây).")
        elif viewer_key:  # one viewer's chat: not more than one line per 8 s, never the same text twice
            last = self._comment_last.get(viewer_key)
            if last and last[1] == fold(safe) and now - last[0] < 60:
                return no("Trùng bình luận vừa đọc.")
            if last and now - last[0] < COMMENT_VIEWER_GAP_S:
                return no("Người này vừa được đọc (cách nhau ít nhất 8 giây).")
        name = speakable_name(item.get("nickname") or item.get("unique_id"), cfg.banned_words)
        tpl = cfg.question_template if as_question else cfg.chat_template
        text = self._fill(tpl, ten=name, cau_hoi=safe, binh_luan=safe)
        clip = self.c.speech.enqueue("question" if as_question else "comment", text, ref=item["event_id"],
                                     droppable=not as_question, busy_limit=cfg.busy_limit * 3,
                                     ttl=90.0 if as_question else COMMENT_TTL_S)
        if clip is None:
            return no("Đang có quá nhiều câu chờ đọc — bỏ qua bình luận thường.")
        self._trace(kind, who, item.get("text"), True, "Đã xếp hàng đọc trên LIVE.")
        if as_question:
            if viewer_key:
                self._viewer_read[viewer_key] = now
        elif viewer_key:
            self._comment_last[viewer_key] = (now, fold(safe))
        item["question_read"] = True
        return True

    # ------------------------------------------------------------------ welcoming viewers
    def start(self) -> None:
        self._welcome_task = asyncio.create_task(self._welcome_loop(), name="welcome")

    async def stop(self) -> None:
        if self._welcome_task:
            self._welcome_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._welcome_task

    def on_join(self, name: str | None, viewer_key: str | None) -> bool:
        """A viewer joined (or said hello): greet them by name — everyone, never twice in 10 minutes."""
        cfg = self.config
        if not cfg.greet_joins:
            self._trace("join", name, None, False, "Đã tắt “Chào người vào xem”.")
            return False
        ok, why = self.voice_ready()
        if not ok:
            self._trace("join", name, None, False, why)
            return False
        now = time.monotonic()
        key = viewer_key or f"name:{name}"
        if now - self._welcomed.get(key, -1e9) < WELCOME_AGAIN_S:
            self._trace("join", name, None, False, "Đã chào người này trong 10 phút qua.")
            return False
        self._welcomed[key] = now
        if len(self._welcomed) > 5000:
            self._welcomed = {k: t for k, t in self._welcomed.items() if now - t < WELCOME_AGAIN_S}
        self._welcome_pending.append((speakable_name(name, cfg.banned_words), key, now))
        self._trace("join", name, None, True, "Chờ gộp vào lời chào.")
        return True

    async def _welcome_loop(self) -> None:
        while True:
            await asyncio.sleep(0.4)
            try:
                self.welcome_flush()
            except Exception:
                log.exception("Lỗi khi chào người xem")

    @staticmethod
    def _name_list(names: list[str], others: int) -> str:
        named = [n for n in names if n != "khách"]
        others += len(names) - len(named)
        parts = list(named)
        if others:
            parts.append(f"{others} bạn {'khác' if named else 'vừa vào'}")
        if len(parts) == 1:
            return parts[0]
        return ", ".join(parts[:-1]) + " và " + parts[-1]

    def welcome_flush(self, now: float | None = None) -> None:
        """One welcome line at a time; everyone who joins meanwhile is gathered into the next line.
        In a huge crowd, names that waited over a minute are greeted as "và N bạn khác"."""
        if not self._welcome_pending:
            return
        cfg = self.config
        sq = self.c.speech
        wc = self._welcome_clip
        if wc is not None and (wc in sq.queue or sq.current is wc):
            return
        ok, why = self.voice_ready()
        if not ok:
            self._trace("welcome", ", ".join(n for n, _, _ in self._welcome_pending[:8]), None, False, why)
            self._welcome_pending.clear()
            return
        now = time.monotonic() if now is None else now
        pending = self._welcome_pending
        batch = cfg.welcome_batch * (2 if len(pending) > cfg.welcome_batch * 3 else 1)
        if len(pending) < batch and now - pending[0][2] < WELCOME_GATHER_S:
            return
        take, rest = pending[:batch], pending[batch:]
        folded = [p for p in rest if now - p[2] > WELCOME_FOLD_S]
        self._welcome_pending = [p for p in rest if now - p[2] <= WELCOME_FOLD_S]
        names = [n for n, _, _ in take]
        if len(names) == 1 and not folded and names[0] != "khách" and cfg.greet_templates:
            tpl = cfg.greet_templates[self._greet_i % len(cfg.greet_templates)]
            self._greet_i += 1
            text = self._fill(tpl, ten=names[0], shop=cfg.shop_name)
        else:
            text = self._fill(cfg.welcome_many_template, danh_sach=self._name_list(names, len(folded)),
                              shop=cfg.shop_name)
        self._welcome_clip = sq.enqueue("welcome", text, ttl=180.0)
        self._trace("welcome", ", ".join(names[:8]) + (f" +{len(folded)}" if folded else ""), text,
                    self._welcome_clip is not None,
                    "Đã xếp lời chào lên LIVE." if self._welcome_clip is not None else "Hàng chờ đầy — không xếp được.")

    # ------------------------------------------------------------------ drafting
    def _prompt(self, item: dict[str, Any], intent: Intent, cfg: AiConfig) -> tuple[str, str, list[str]]:
        catalog = self.c.catalog
        focus = [p for p in [intent.product_id, *[p for p, _ in intent.candidates[:3]]] if p]
        question = sanitize_comment(item["text"], [], max_len=300) or "(trống)"
        user = catalog_context(catalog, focus, cfg.shop_facts) + f"\n<binh_luan>{question}</binh_luan>"
        if intent.product_id:
            user += f"\n<goi_y_san_pham>{intent.product_id}</goi_y_san_pham>"
        elif focus:
            user += f"\n<co_the_la>{', '.join(focus)}</co_the_la>"
        return system_prompt(cfg.shop_name), user, list(catalog.products)

    async def _call_claude(self, item: dict[str, Any], intent: Intent, cfg: AiConfig, key: str) -> Draft:
        system, user, ids = self._prompt(item, intent, cfg)
        async with self._sem:
            comp = await asyncio.wait_for(
                self.client.complete(api_key=key, model=cfg.model, system=system, user=user,
                                     schema=answer_schema(ids), max_tokens=cfg.max_output_tokens),
                timeout=20.0)
        try:
            raw = json.loads(comp.text)
        except ValueError as exc:
            raise ClaudeError("bad_json", "Claude trả về dữ liệu không đúng định dạng.") from exc
        draft = check_draft(raw, self.c.catalog)
        draft.tokens_in, draft.tokens_out = comp.tokens_in, comp.tokens_out
        return draft

    async def make_draft(self, item: dict[str, Any], intent: Intent) -> tuple[Draft | None, str | None]:
        """(draft, why-not-claude). Never raises."""
        cfg = self.config
        folded = " ".join(fold(item["text"]).split())
        template = template_reply(folded, intent.product_id, self.c.catalog)
        if cfg.simple_auto:
            hit = self.memory.match(item["text"], intent.product_id, self.c.catalog, cfg.memory_threshold)
            if hit:
                return Draft(hit.entry.intent or "OTHER", hit.entry.product_id, hit.score, hit.answer, False, [],
                             source="memory", knowledge_id=hit.entry.id, match_score=round(hit.score, 2)), None
            if template:
                return template, None
        key = self.api_key()
        if not key:
            return template, "Chưa cài Claude API key."
        ckey = (folded, intent.product_id, self.c.catalog.version, cfg.model)
        hit = self._cache.get(ckey)
        if hit and time.monotonic() - hit[1] < CACHE_TTL_S:
            d = hit[0]
            return Draft(d.intent, d.product_id, d.confidence, d.reply, d.needs_review, list(d.review_reasons),
                         source="cache"), None
        system, user, _ = self._prompt(item, intent, cfg)
        worst = self.budget.worst_case(cfg.model, len(system) + len(user), cfg.max_output_tokens)
        if not self.budget.allows(worst, cfg.budget_day_usd, cfg.budget_month_usd):
            return template, "Đã chạm hạn mức chi phí AI."
        try:
            draft = await self._call_claude(item, intent, cfg, key)
        except ClaudeError as exc:
            self.last_error = exc.message
            log.warning("Claude: %s", exc.message, extra={"ctx": {"mã": exc.code, "model": cfg.model}})
            return template, exc.message
        except TimeoutError:
            self.last_error = "Claude trả lời quá lâu."
            log.warning("Claude trả lời quá lâu (quá 20 giây)", extra={"ctx": {"model": cfg.model}})
            return template, self.last_error
        except Exception as exc:
            log.exception("Lỗi gọi Claude")
            self.last_error = f"Lỗi gọi Claude: {type(exc).__name__}"
            return template, self.last_error
        self.last_error = None
        cost = self.budget.record(cfg.model, draft.tokens_in, draft.tokens_out, cfg.budget_day_usd, cfg.budget_month_usd)
        item["cost_usd"] = cost
        await asyncio.to_thread(self._log_message, item, draft, cfg.model, cost)
        self._cache[ckey] = (draft, time.monotonic())
        return draft, None

    def _log_message(self, item: dict[str, Any], draft: Draft, model: str, cost: float) -> None:
        with self.c.db.session() as s:
            row = AiMessage(session_id=self.c.live.session_id, input=sanitize_comment(item["text"], [], 300) or "",
                            draft=draft.reply, model=model, tokens_in=draft.tokens_in, tokens_out=draft.tokens_out,
                            cost_usd=cost)
            s.add(row)
            s.flush()
            item["ai_message_id"] = row.id

    async def _draft_and_maybe_speak(self, item: dict[str, Any], intent: Intent) -> None:
        if self.api_key():
            self._update(item, status=ST_DRAFTING)
        draft, why = await self.make_draft(item, intent)
        cfg = self.config
        if draft is not None and draft.source in ("memory", "template") and why is None:
            await self._answer_simple(item, draft, cfg)
            return
        if draft is None:
            base = item.get("hint") or "Người trực trả lời trực tiếp."
            self._update(item, status=ST_NEW, hint=f"{base} ({why})" if why and why not in base else base)
            return
        reasons = list(draft.review_reasons)
        status = ST_REVIEW if draft.needs_review else ST_SUGGESTED
        label = SOURCE_LABEL[draft.source]
        hint = f"{why} Dùng câu mẫu từ danh mục." if why else (
            "Xem câu gợi ý, bấm Đọc hoặc sửa trước khi đọc." if draft.needs_review or cfg.answer_mode == "approve" else None)
        self._update(item, status=status, suggestion=draft.reply, suggestion_label=label,
                     review_reasons=[*item.get("review_reasons", []), *reasons], hint=hint,
                     ai_intent=draft.intent, ai_confidence=round(draft.confidence, 2), draft_source=draft.source)
        for other in self.items.values():  # duplicates that arrived meanwhile get the answer too
            if other.get("duplicate_of") == item["event_id"]:
                self._update(other, suggestion=draft.reply)
        ok, _ = self.voice_ready()
        auto = cfg.answer_mode == "auto" or cfg.autopilot
        if auto and not draft.needs_review and ok and self._speak_chat_then(item) and self._speak_answer(item, draft.reply):
            self._update(item, status=ST_AUTO, final_answer=draft.reply, answered_by="auto", spoken=True)
            if draft.source in ("claude", "cache"):
                self._learn(item, draft.reply, trusted=False, source="auto")  # waits for a person's review

    async def _answer_simple(self, item: dict[str, Any], draft: Draft, cfg: AiConfig) -> None:
        """A learned answer or a catalog price answer: no Claude call, read at once if allowed."""
        common = {"suggestion": draft.reply, "suggestion_label": SOURCE_LABEL[draft.source], "draft_source": draft.source,
                      "ai_intent": draft.intent, "knowledge_id": draft.knowledge_id, "match_score": draft.match_score}
        if draft.knowledge_id:
            self._spawn(asyncio.to_thread(self.memory.mark_used, draft.knowledge_id))
        ok, why = self.voice_ready()
        if (cfg.simple_auto_speak or cfg.autopilot) and ok and self._speak_chat_then(item) \
                and self._speak_answer(item, draft.reply):
            self._update(item, status=ST_SIMPLE, final_answer=draft.reply, answered_by=draft.source, spoken=True,
                         hint="Câu đơn giản — tự trả lời, không gọi Claude.", **common)
            return
        self._update(item, status=ST_SUGGESTED, hint="Câu đơn giản — có sẵn câu trả lời, không gọi Claude."
                     + ("" if ok else f" (Chưa phát giọng: {why})"), **common)

    # ------------------------------------------------------------------ "Tự động hoàn toàn"
    def _social_ok(self, kind: str, gap: float, viewer_key: str | None, now: float) -> bool:
        cfg = self.config
        if not cfg.autopilot or self.c.ai_paused or not self.voice_ready()[0]:
            return False
        if now - self._kind_last.get(kind, -1e9) < gap:
            return False
        if viewer_key and now - self._viewer_social.get(viewer_key, -1e9) < VIEWER_SOCIAL_GAP_S:
            return False
        return self.c.speech.pending() < cfg.busy_limit

    def wants_chat(self, intent: Intent, viewer_key: str | None) -> bool:
        """An ordinary comment (not a question/product/greeting) that autopilot should answer."""
        cfg = self.config
        return (intent.kind == IntentKind.NONE and cfg.autopilot and cfg.auto_chat
                and self._social_ok("chat", CHAT_GAP_S, viewer_key, time.monotonic()))

    def _speak_chat_then(self, item: dict[str, Any]) -> bool:
        """Small talk is read out only together with its answer: queue the comment first."""
        if not item.get("chat") or item.get("question_read"):
            return True
        cfg = self.config
        safe = sanitize_comment(item["text"], cfg.banned_words)
        if safe is None:
            return False
        name = speakable_name(item.get("nickname") or item.get("unique_id"), cfg.banned_words)
        try:
            text = cfg.chat_template.format(ten=name, binh_luan=safe, cau_hoi=safe)
        except (KeyError, IndexError, ValueError):
            text = f"Bạn {name} nói: {safe}"
        clip = self.c.speech.enqueue("comment", text, ref=item["event_id"])
        if clip is None:
            return False
        now = time.monotonic()
        self._kind_last["chat"] = now
        if item.get("viewer_key"):
            self._viewer_social[item["viewer_key"]] = now
        item["question_read"] = True
        return True

    def on_other(self, record: dict[str, Any], intent: Intent, viewer_key: str | None) -> None:
        """Greetings and product-name comments in autopilot: one short spoken line, no Claude."""
        cfg = self.config
        now = time.monotonic()
        name = speakable_name(record.get("nickname") or record.get("unique_id"), cfg.banned_words)
        who = record.get("nickname") or record.get("unique_id")
        if contains_banned(record["text"], cfg.banned_words):
            self._trace("comment", who, record["text"], False, "Có từ cấm — không đọc.")
            return
        text: str | None = None
        kind = ""
        if intent.kind == IntentKind.SPAM:
            self._trace("comment", who, record["text"], False, "Bị xem là spam — không đọc.")
            return
        greeted_before = False
        if intent.kind == IntentKind.GREETING and cfg.greet_joins:
            if self.on_join(record.get("nickname") or record.get("unique_id"), viewer_key):
                self._persist({**record, "status": ST_SIMPLE, "final_answer": "(được chào trong lời chào người xem)",
                               "answered_by": "auto", "spoken": True})
                return
            if not self.voice_ready()[0]:
                return
            greeted_before = True  # already welcomed a moment ago: read their hello like any comment
        if greeted_before or (intent.kind != IntentKind.GREETING
                              and not (intent.kind == IntentKind.PRODUCT and cfg.autopilot
                                       and cfg.auto_product and intent.product_id)):
            if self.read_comment(dict(record), viewer_key, now, as_question=False):  # "Bạn Lan nói: …"
                self._persist({**record, "status": "Đã đọc to", "spoken": True})
            return
        if intent.kind == IntentKind.GREETING and cfg.autopilot and cfg.auto_greet and cfg.greet_templates:
            if not self._social_ok("greeting", GREET_GAP_S, viewer_key, now):
                return
            tpl = cfg.greet_templates[self._greet_i % len(cfg.greet_templates)]
            self._greet_i += 1
            text, kind = self._fill(tpl, ten=name, shop=cfg.shop_name), "greeting"
        elif intent.kind == IntentKind.PRODUCT and cfg.auto_product and intent.product_id:
            pid = intent.product_id
            if now - self._product_last.get(pid, -1e9) < SAME_PRODUCT_GAP_S:
                return
            if not self._social_ok("product", PRODUCT_GAP_S, viewer_key, now):
                return
            p = self.c.catalog.products.get(pid)
            if p is None:
                return
            if p.display_price:
                text = self._fill(cfg.product_template, ten=name, san_pham=p.name, gia=format_vnd(p.display_price))
            else:  # no verified price: never say one
                text = f"Bạn {name} đang xem {p.name} ạ."
            kind = "product"
            self._product_last[pid] = now
        if not text:
            return
        clip = self.c.speech.enqueue(kind, text, ref=record["event_id"], droppable=True, busy_limit=cfg.busy_limit)
        if clip is None:
            return
        self._kind_last[kind] = now
        if viewer_key:
            self._viewer_social[viewer_key] = now
        self._persist({**record, "status": ST_SIMPLE, "suggestion": text, "draft_source": "template",
                       "final_answer": text, "answered_by": "auto", "spoken": True})

    @staticmethod
    def _fill(template: str, **values: str) -> str:
        try:
            return template.format(**values)
        except (KeyError, IndexError, ValueError):
            return " ".join(v for v in values.values() if v)

    # ------------------------------------------------------------------ host actions
    def _speak_answer(self, item: dict[str, Any], text: str) -> bool:
        cfg = self.config
        prefix = cfg.answer_prefix.strip()
        clip = self.c.speech.enqueue("answer", f"{prefix} {text}".strip() if prefix else text, ref=item["event_id"])
        if clip:
            item["answer_clip"] = clip.id
        return clip is not None

    def approve(self, event_id: str, text: str | None, admin_id: int | None) -> dict[str, Any]:
        item = self.items.get(event_id)
        if item is None:
            raise KeyError(event_id)
        reply = " ".join((text if text is not None else item.get("suggestion") or "").split())
        if not reply:
            raise ValueError("Chưa có câu trả lời để đọc.")
        if len(reply) > 280:
            raise ValueError("Câu trả lời tối đa 280 ký tự (một lần đọc).")
        ok, why = self.voice_ready()
        spoken = ok and self._speak_answer(item, reply)
        self._update(item, status=ST_CONFIRMED, suggestion=reply, spoken=spoken, final_answer=reply, answered_by="host",
                     hint=item.get("hint") if spoken else f"Không phát giọng: {why or 'hết hạn mức ký tự'}")
        self._learn(item, reply, trusted=True, source="host")
        if item.get("ai_message_id"):
            self._spawn(asyncio.to_thread(self._mark_approved, item["ai_message_id"]))
        return {"spoken": spoken, "reason": None if spoken else (why or "Hết hạn mức ký tự giọng đọc."), "item": item}

    def _mark_approved(self, ai_id: int) -> None:
        with self.c.db.session() as s:
            row = s.get(AiMessage, ai_id)
            if row:
                row.approved_by_host = True

    def dismiss(self, event_id: str) -> dict[str, Any]:
        item = self.items.get(event_id)
        if item is None:
            raise KeyError(event_id)
        self._update(item, status=ST_DISMISSED)
        return item

    # ------------------------------------------------------------------ tests from the settings page
    async def test_claude(self, key: str | None, model: str) -> dict[str, Any]:
        key = key or self.api_key()
        if not key:
            return {"ok": False, "message": "Chưa nhập Claude API key."}
        names = list(self.c.catalog.products.values())
        sample = f"{names[0].name} giá bao nhiêu vậy shop?" if names else "Shop có ship COD không?"
        item = {"text": sample, "event_id": "test"}
        pid = names[0].id if names else None
        intent = Intent(IntentKind.QUESTION, pid)
        cfg = self.config.model_copy(update={"model": model})
        system, user, ids = self._prompt(item, intent, cfg)
        try:
            comp = await asyncio.wait_for(self.client.complete(
                api_key=key, model=model, system=system, user=user, schema=answer_schema(ids),
                max_tokens=cfg.max_output_tokens), timeout=25.0)
            draft = check_draft(json.loads(comp.text), self.c.catalog)
        except ClaudeError as exc:
            log.warning("Thử kết nối Claude thất bại: %s", exc.message, extra={"ctx": {"mã": exc.code, "model": model}})
            return {"ok": False, "message": exc.message}
        except (TimeoutError, ValueError):
            log.warning("Thử kết nối Claude: không trả lời đúng hạn hoặc sai định dạng", extra={"ctx": {"model": model}})
            return {"ok": False, "message": "Claude không trả lời đúng hạn hoặc sai định dạng."}
        cost = self.budget.record(model, comp.tokens_in, comp.tokens_out, cfg.budget_day_usd, cfg.budget_month_usd)
        return {"ok": True, "question": sample, "reply": draft.reply, "needs_review": draft.needs_review,
                "review_reasons": draft.review_reasons, "tokens_in": comp.tokens_in, "tokens_out": comp.tokens_out,
                "cost_usd": round(cost, 6), "message": "Kết nối Claude thành công."}
