"""CommentIntentRouter: rules first; only QUESTION/AMBIGUOUS may later go to Claude (M4)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum

from app.services.product_matcher import MatchStatus, ProductMatcher
from app.text_norm import fold

QUESTION_PHRASES = (
    "bao nhieu", "bn", "bnhiu", "bnh", "may tien", "nhieu tien", "gia", "xin gia", "ib", "inbox",
    "thanh phan", "co tot khong", "tot khong", "uong the nao", "uong sao", "dung the nao", "dung sao",
    "cach dung", "ntn", "nhu the nao", "the nao", "han su dung", "o dau", "sao", "con hang",
    "co ship", "ship", "freeship", "phi ship", "ck", "chuyen khoan", "cod",
)
# Vietnamese yes/no questions end with a particle: "còn không", "có ship ko", "được chưa"
QUESTION_ENDINGS = {"khong", "ko", "k", "hok", "hong", "hem", "chua", "ha", "a ha"}
GREETING_WORDS = ("chao", "hello", "hi", "xin chao", "alo")
DANCE_WORDS = ("nhay", "dance", "quay")
_URL = re.compile(r"(https?://|www\.|\.(com|net|vn|xyz|top)\b)", re.I)


class IntentKind(StrEnum):
    PRODUCT = "PRODUCT"
    QUESTION = "QUESTION"
    AMBIGUOUS = "AMBIGUOUS"
    GREETING = "GREETING"
    DANCE = "DANCE"
    SPAM = "SPAM"
    NONE = "NONE"


@dataclass
class Intent:
    kind: IntentKind
    product_id: str | None = None
    confidence: float = 0.0
    tier: str | None = None
    candidates: list[tuple[str, float]] = field(default_factory=list)
    normalized: str = ""

    @property
    def moves_chibi(self) -> bool:
        return self.product_id is not None and self.kind in (IntentKind.PRODUCT, IntentKind.QUESTION)

    @property
    def needs_host(self) -> bool:
        return self.kind in (IntentKind.AMBIGUOUS, IntentKind.QUESTION)


def _has_phrase(folded: str, phrases: tuple[str, ...]) -> bool:
    padded = f" {folded} "
    return any(f" {p} " in padded for p in phrases)


class CommentIntentRouter:
    def __init__(self, matcher: ProductMatcher):
        self.matcher = matcher

    def route(self, text: str) -> Intent:
        if _URL.search(text):
            return Intent(IntentKind.SPAM, normalized=fold(text))
        folded = fold(text)
        tokens = folded.split()
        is_question = (
            "?" in text
            or _has_phrase(folded, QUESTION_PHRASES)
            or (len(tokens) >= 2 and (tokens[-1] in QUESTION_ENDINGS or " ".join(tokens[-2:]) in QUESTION_ENDINGS))
            or (len(tokens) >= 3 and tokens[-2] in QUESTION_ENDINGS and tokens[-1] in {"shop", "ad", "a", "vay", "nhi"})
        )
        m = self.matcher.match(text)
        if m.status == MatchStatus.MATCH:
            kind = IntentKind.QUESTION if is_question else IntentKind.PRODUCT
            return Intent(kind, m.product_id, m.confidence, m.tier, m.candidates, m.normalized)
        if m.status == MatchStatus.AMBIGUOUS:
            return Intent(IntentKind.AMBIGUOUS, None, m.confidence, m.tier, m.candidates, m.normalized)
        if is_question:
            return Intent(IntentKind.QUESTION, normalized=m.normalized)
        if _has_phrase(folded, GREETING_WORDS):
            return Intent(IntentKind.GREETING, normalized=m.normalized)
        if _has_phrase(folded, DANCE_WORDS):
            return Intent(IntentKind.DANCE, normalized=m.normalized)
        return Intent(IntentKind.NONE, normalized=m.normalized)
