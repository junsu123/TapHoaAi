"""Question desk (AI-02…AI-06, HOST-01/02): a viewer's question → read aloud → Claude draft →
host approves (or, in auto mode, safe drafts are read at once).

Rules first: only comments the router marks QUESTION/AMBIGUOUS reach here, product-name comments
never cost an API call. Duplicates within two minutes share one answer, drafts are cached, every
call must fit the budget, and when anything is missing (no key, budget used up, AI paused, Claude
down) the game keeps running and the host still sees the question, with a catalog-only template
answer when one applies."""

from __future__ import annotations

import asyncio
import json
import logging
import time
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
from app.services.text_safety import sanitize_comment, scrub_pii, speakable_name
from app.services.tts_vbee import FakeTts, VbeeTts
from app.text_norm import fold

if TYPE_CHECKING:
    from app.container import AppContainer

log = logging.getLogger("chibi.ai")

DUPLICATE_WINDOW_S = 120.0
CACHE_TTL_S = 30 * 60
VIEWER_READ_GAP_S = 20.0  # one viewer's questions are read aloud at most this often
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
        self._sem = asyncio.Semaphore(2)
        self._tasks: set[asyncio.Task] = set()
        self.last_error: str | None = None

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

    def apply_voice(self) -> None:
        sq = self.c.speech
        cfg = self.config
        sq.voice, sq.speed = cfg.voice_code, cfg.voice_speed
        if self.fake:
            sq.provider = FakeTts()
        else:
            app_id, token = self.c.get_setting(SECRET_VBEE_APP_ID), self.c.get_setting(SECRET_VBEE_TOKEN)
            sq.provider = VbeeTts(app_id, token) if app_id and token else None

    def voice_ready(self) -> tuple[bool, str]:
        cfg = self.config
        if self.c.settings.tts_locked:
            return False, "Giọng đọc bị khóa bằng CHIBI_TTS_LOCKED."
        if not cfg.voice_enabled or not cfg.voice_policy_confirmed:
            return False, "Giọng đọc đang tắt."
        if self.c.speech.provider is None:
            return False, "Chưa nhập App ID/Token Vbee."
        if self.c.ai_paused:
            return False, "AI đang tạm dừng."
        if self.c.speech.muted:
            return False, "Giọng đã bị tắt bằng nút khẩn cấp."
        if not self.budget.tts_allows(1, cfg.voice_month_chars):
            return False, "Đã hết hạn mức ký tự giọng đọc của tháng."
        return True, ""

    def status(self) -> dict[str, Any]:
        cfg = self.config
        ok, why = self.voice_ready()
        return {"configured": bool(self.api_key()), "model": cfg.model, "paused": self.c.ai_paused,
                "budget": self.budget.status(cfg.budget_day_usd, cfg.budget_month_usd, cfg.voice_month_chars),
                "voice_ready": ok, "voice_reason": why, "answer_mode": cfg.answer_mode,
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
            log.exception("conversation log failed")

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
        if intent.kind not in (IntentKind.QUESTION, IntentKind.AMBIGUOUS):
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
        self._persist(item)
        self._spawn(self._draft_and_maybe_speak(item, intent))

    def _read_question(self, item: dict[str, Any], viewer_key: str | None, now: float) -> None:
        cfg = self.config
        ok, _ = self.voice_ready()
        if not (ok and cfg.read_questions):
            return
        if viewer_key and now - self._viewer_read.get(viewer_key, -1e9) < VIEWER_READ_GAP_S:
            return
        safe = sanitize_comment(item["text"], cfg.banned_words)
        if safe is None:
            item["review_reasons"] = [*item.get("review_reasons", []), "Không đọc to: có từ cấm hoặc toàn liên kết/số"]
            return
        name = speakable_name(item.get("nickname") or item.get("unique_id"), cfg.banned_words)
        try:
            text = cfg.question_template.format(ten=name, cau_hoi=safe)
        except (KeyError, IndexError, ValueError):
            text = f"Bạn {name} hỏi: {safe}"
        if self.c.speech.enqueue("question", text, ref=item["event_id"]):
            if viewer_key:
                self._viewer_read[viewer_key] = now
            item["question_read"] = True

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
            return template, exc.message
        except TimeoutError:
            self.last_error = "Claude trả lời quá lâu."
            return template, self.last_error
        except Exception as exc:
            log.exception("claude call failed")
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
        if cfg.answer_mode == "auto" and not draft.needs_review and ok and self._speak_answer(item, draft.reply):
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
        if cfg.simple_auto_speak and ok and self._speak_answer(item, draft.reply):
            self._update(item, status=ST_SIMPLE, final_answer=draft.reply, answered_by=draft.source, spoken=True,
                         hint="Câu đơn giản — tự trả lời, không gọi Claude.", **common)
            return
        self._update(item, status=ST_SUGGESTED, hint="Câu đơn giản — có sẵn câu trả lời, không gọi Claude."
                     + ("" if ok else f" (Chưa phát giọng: {why})"), **common)

    # ------------------------------------------------------------------ host actions
    def _speak_answer(self, item: dict[str, Any], text: str) -> bool:
        cfg = self.config
        if not self.budget.tts_allows(len(text), cfg.voice_month_chars):
            return False
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
            return {"ok": False, "message": exc.message}
        except (TimeoutError, ValueError):
            return {"ok": False, "message": "Claude không trả lời đúng hạn hoặc sai định dạng."}
        cost = self.budget.record(model, comp.tokens_in, comp.tokens_out, cfg.budget_day_usd, cfg.budget_month_usd)
        return {"ok": True, "question": sample, "reply": draft.reply, "needs_review": draft.needs_review,
                "review_reasons": draft.review_reasons, "tokens_in": comp.tokens_in, "tokens_out": comp.tokens_out,
                "cost_usd": round(cost, 6), "message": "Kết nối Claude thành công."}
