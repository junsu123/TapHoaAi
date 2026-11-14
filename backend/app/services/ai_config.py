"""Settings of the AI sales assistant (Claude) and of the voice (Vbee TTS).

Non-secret options are one JSON document in the encrypted settings table; the Claude API key and
the Vbee App ID/token are separate secret settings that are never sent back to the browser."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from app.container import AppContainer

# USD per million tokens (input, output), prompts ≤ 100k tokens — platform.claude.com pricing,
# checked 2026-11. Unknown models are costed at the most expensive known rate.
MODEL_PRICES: dict[str, tuple[float, float]] = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-opus-5-5": (4.0, 20.0),
}
DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_VOICE = "hn_female_ngochuyen_full_48k-fhg"  # Vbee "HN - Ngọc Huyền"

SECRET_CLAUDE_KEY = "claude_api_key"
SECRET_VBEE_APP_ID = "vbee_app_id"
SECRET_VBEE_TOKEN = "vbee_token"
CONFIG_KEY = "ai_config"


def price_of(model: str) -> tuple[float, float]:
    return MODEL_PRICES.get(model, max(MODEL_PRICES.values()))


class AiConfig(BaseModel):
    # --- Claude -------------------------------------------------------------
    model: str = Field(DEFAULT_MODEL, max_length=64, pattern=r"^[a-z0-9][a-z0-9.\-]*$")
    budget_day_usd: float = Field(0.5, ge=0, le=100)
    budget_month_usd: float = Field(15.0, ge=0, le=1000)  # PRD J: Claude 15 USD of the 100 USD/month
    max_output_tokens: int = Field(300, ge=64, le=1024)
    shop_name: str = Field("shop", max_length=80)
    shop_facts: str = Field("", max_length=3000)  # shipping, payment, returns… written by the owner
    banned_words: list[str] = Field(default_factory=list, max_length=200)
    # --- voice (AI-06: off until the owner turns it on and confirms the policy checklist) ----------
    voice_enabled: bool = False
    voice_policy_confirmed: bool = False
    read_questions: bool = True
    answer_mode: Literal["approve", "auto"] = "approve"
    voice_code: str = Field(DEFAULT_VOICE, max_length=80, pattern=r"^[A-Za-z0-9_\-.]+$")
    voice_speed: float = Field(1.0, ge=0.5, le=1.6)
    voice_month_chars: int = Field(200_000, ge=0, le=50_000_000)
    question_template: str = Field("Bạn {ten} hỏi: {cau_hoi}", max_length=120)
    answer_prefix: str = Field("", max_length=60)
    # --- answer memory (learned answers, no Claude call) ----------------------------------------
    simple_auto: bool = True  # a learned answer or a catalog price answer replaces the Claude call
    simple_auto_speak: bool = True  # …and is read at once (it was confirmed by a person before)
    learn_enabled: bool = True  # remember answers a person confirmed (and auto answers, as "chờ duyệt")
    memory_threshold: float = Field(0.75, ge=0.5, le=1.0)
    # --- "Tự động hoàn toàn": read comments and answer without the host --------------------------
    autopilot: bool = False
    auto_greet: bool = True  # greetings → a short greeting template (no Claude)
    auto_product: bool = True  # product-name comments → "Bạn … đang xem …, giá …" (no Claude)
    auto_chat: bool = True  # other comments → Claude; read only together with a safe reply
    busy_limit: int = Field(3, ge=1, le=10)  # clips waiting before greetings/chat are skipped
    greet_templates: list[str] = Field(default_factory=lambda: [
        "Chào bạn {ten}, cảm ơn bạn đã ghé LIVE của {shop} ạ!",
        "{ten} ơi, shop chào bạn nha, cần gì cứ hỏi shop ạ!",
        "Chào {ten}, chúc bạn xem LIVE vui vẻ ạ!",
    ], max_length=10)
    product_template: str = Field("Bạn {ten} đang xem {san_pham}, giá {gia} ạ.", max_length=160)
    chat_template: str = Field("Bạn {ten} nói: {binh_luan}", max_length=120)


def load_config(c: AppContainer) -> AiConfig:
    raw = c.get_setting(CONFIG_KEY)
    if raw:
        try:
            return AiConfig.model_validate(json.loads(raw))
        except (ValueError, TypeError):
            pass
    return AiConfig()


def save_config(c: AppContainer, cfg: AiConfig) -> None:
    c.set_setting(CONFIG_KEY, cfg.model_dump_json(), secret=False)


def mask(secret: str | None) -> str | None:
    if not secret:
        return None
    return f"{secret[:6]}…{secret[-4:]}" if len(secret) > 14 else "••••"
