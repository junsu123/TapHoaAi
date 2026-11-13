"""Vietnamese text normalisation used for matching (never for display).

normalize_vi("Shop ơi cho mình xem Trà Cà Gai Leo nhé!!") == "tra ca gai leo"
"""

from __future__ import annotations

import re
import unicodedata

_CONTROL = re.compile("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]")
_NON_WORD = re.compile(r"[^0-9a-z]+")

# Filler words stripped from the START or END of a comment only (configurable later).
LEADING_FILLERS: tuple[str, ...] = (
    "shop oi cho minh xem",
    "shop oi cho em xem",
    "shop oi cho xem",
    "cho minh xem",
    "cho em xem",
    "cho xem",
    "shop oi",
    "ad oi",
    "xem",
    "lay",
    "minh muon",
    "em muon",
)
TRAILING_FILLERS: tuple[str, ...] = ("nhe", "nha", "voi", "a", "ah", "di", "shop oi", "shop", "ad")

MAX_COMMENT_CHARS = 300


def clean_display_text(text: str, max_chars: int = MAX_COMMENT_CHARS) -> str:
    """Strip control / zero-width characters and trim. Keeps Vietnamese diacritics."""
    text = unicodedata.normalize("NFC", text or "")
    text = _CONTROL.sub("", text)
    text = " ".join(text.split())
    return text[:max_chars]


def strip_diacritics(text: str) -> str:
    text = text.replace("đ", "d").replace("Đ", "D")
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def fold(text: str) -> str:
    """Lowercase, remove diacritics, punctuation and emoji; collapse whitespace."""
    text = clean_display_text(text).lower()
    text = strip_diacritics(text)
    text = _NON_WORD.sub(" ", text)
    return " ".join(text.split())


def strip_fillers(folded: str) -> str:
    changed = True
    s = folded
    while changed and s:
        changed = False
        for f in LEADING_FILLERS:
            if s == f:
                break
            if s.startswith(f + " "):
                s = s[len(f) + 1 :]
                changed = True
                break
        for f in TRAILING_FILLERS:
            if s.endswith(" " + f):
                s = s[: -(len(f) + 1)]
                changed = True
                break
    return s


def normalize_vi(text: str) -> str:
    return strip_fillers(fold(text))
