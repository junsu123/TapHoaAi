"""What may be said out loud on a selling LIVE.

* Viewer comments read aloud: links, phone numbers and e-mails are removed (their PII, and
  spam), banned words make the comment not read at all.
* AI answers: health/medical promises and prices that are not in the catalog send the draft to
  the host instead of the speaker, whatever the answer mode."""

from __future__ import annotations

import re

from app.text_norm import clean_display_text, fold, strip_diacritics

# Always applied when reading viewer comments aloud, on top of the shop's own list (folded forms,
# so "đm", "dm", "Đ.M" all match). Kept short and unambiguous on purpose.
BUILTIN_BANNED = (
    # only forms that are not also everyday words once diacritics are removed
    # (not "lon"/"cac"/"buoi"/"deo"/"con cho", which also mean can, the, session, wear, "still give")
    "dm", "dmm", "dcm", "dit", "dit me", "du ma", "du me", "vcl", "vkl", "vl", "vai lon", "clm", "cmm",
    "cho chet", "do ngu", "oc cho", "dit con", "me may", "bo may", "fuck", "shit", "bitch", "lua dao",
)
_URL = re.compile(r"(https?://\S+|www\.\S+|\b\S+\.(com|net|vn|xyz|top|me|io)\b\S*)", re.IGNORECASE)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")
_PHONE = re.compile(r"(?<!\d)(?:\+?84|0)(?:[\s.\-]?\d){8,10}(?!\d)")
_LONG_DIGITS = re.compile(r"\d{6,}")
_MENTION = re.compile(r"(^|\s)@\w+")

# Health/medical promises a food or herbal product may not make in advertising (VN rules on
# health-food advertising); folded, without diacritics.
RISKY_CLAIMS = (
    "chua benh", "chua khoi", "chua duoc", "tri benh", "tri khoi", "tri duoc", "dieu tri", "dac tri",
    "tri dut", "dut diem", "khoi benh", "khoi han", "thay the thuoc", "thay thuoc", "khong can uong thuoc",
    "ung thu", "tieu duong", "huyet ap", "xo gan", "viem gan", "gan nhiem mo", "giai doc gan", "phong benh",
    "ngua benh", "100%", "cam ket khoi", "hieu qua tuyet doi", "tang cuong sinh ly", "thuoc",
)
_PRICE = re.compile(r"(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(k|nghin|ngan|d|dong|vnd|trieu|tr)\b")


def contains_banned(text: str, banned: list[str], builtin: bool = True) -> bool:
    folded = f" {fold(text)} "
    squeezed = f" {fold(re.sub(r'[._*-]', '', text))} "  # "đ.m", "v-c-l"
    words = [*(BUILTIN_BANNED if builtin else ()), *banned]
    return any(f" {fold(w)} " in folded or f" {fold(w)} " in squeezed for w in words if fold(w))


def sanitize_comment(text: str, banned: list[str], max_len: int = 160) -> str | None:
    """Text of a viewer comment that is safe to read aloud, or None when it must not be read."""
    if contains_banned(text, banned):
        return None
    t = clean_display_text(text)
    t = _URL.sub(" ", t)
    t = _EMAIL.sub(" ", t)
    t = _PHONE.sub(" ", t)
    t = _LONG_DIGITS.sub(" ", t)
    t = _MENTION.sub(" ", t)
    t = " ".join(t.split())
    if len(fold(t)) < 2:
        return None
    if len(t) > max_len:
        t = t[:max_len].rsplit(" ", 1)[0] + "…"
    return t


def scrub_pii(text: str, max_len: int = 300) -> str:
    """Comment text for the conversation log: links, e-mails and phone numbers removed."""
    t = clean_display_text(text)
    for rx in (_URL, _EMAIL, _PHONE, _LONG_DIGITS):
        t = rx.sub(" ", t)
    return " ".join(t.split())[:max_len]


def speakable_name(nickname: str | None, banned: list[str]) -> str:
    name = clean_display_text(nickname or "").strip()
    name = re.sub(r"[_\.]+", " ", name)
    name = re.sub(r"\d{3,}", "", name).strip()
    if not name or contains_banned(name, banned) or len(name) > 30:
        return "khách"
    return name


def risky_claims(text: str) -> list[str]:
    folded = f" {fold(text)} "
    return [c for c in RISKY_CLAIMS if f" {c} " in folded or (c == "100%" and "100%" in text)]


def _amount(num: str, unit: str) -> int:
    n = int(re.sub(r"[.,]", "", num))
    if unit == "k" or unit in ("nghin", "ngan"):
        return n * 1000
    if unit in ("trieu", "tr"):
        return n * 1_000_000
    return n


def unknown_prices(text: str, known_prices: set[int]) -> list[int]:
    """Prices said in the reply that are not the price of any approved product."""
    t = strip_diacritics(text.lower()).replace("₫", " d")
    out = []
    for m in _PRICE.finditer(t):
        v = _amount(m.group(1), m.group(2))
        if v >= 1000 and v not in known_prices:
            out.append(v)
    return out


def format_vnd(v: int) -> str:
    return f"{v:,}".replace(",", ".") + " đồng"
