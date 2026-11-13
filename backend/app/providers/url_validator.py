"""TikTok LIVE URL validation by pure parsing — this module never performs network I/O
(NFR-05: no SSRF). Short links (vm./vt.tiktok.com) need a redirect lookup, which the M3
adapter performs with an allowlist re-check on every hop."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

ALLOWED_HOSTS = {"www.tiktok.com", "tiktok.com", "m.tiktok.com"}
SHORT_LINK_HOSTS = {"vm.tiktok.com", "vt.tiktok.com"}
_USERNAME = re.compile(r"^[A-Za-z0-9_.]{2,24}$")


class InvalidLiveUrl(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ParsedLiveUrl:
    url: str
    unique_id: str | None
    needs_resolution: bool = False


def parse_live_url(raw: str) -> ParsedLiveUrl:
    url = (raw or "").strip()
    if not url:
        raise InvalidLiveUrl("empty", "Vui lòng dán link TikTok LIVE.")
    if len(url) > 512:
        raise InvalidLiveUrl("too_long", "Link quá dài.")
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise InvalidLiveUrl("malformed", "Link không đúng định dạng.") from exc

    if parts.scheme != "https":
        raise InvalidLiveUrl("scheme", "Link phải bắt đầu bằng https://")
    if parts.username or parts.password or parts.port:
        raise InvalidLiveUrl("host", "Link không hợp lệ: chỉ chấp nhận tên miền tiktok.com.")
    host = (parts.hostname or "").lower().rstrip(".")
    if host in SHORT_LINK_HOSTS:
        return ParsedLiveUrl(url=url, unique_id=None, needs_resolution=True)
    if host not in ALLOWED_HOSTS:
        raise InvalidLiveUrl("host", "Link không hợp lệ: chỉ chấp nhận tên miền tiktok.com.")

    segments = [s for s in parts.path.split("/") if s]
    if not segments or not segments[0].startswith("@"):
        raise InvalidLiveUrl(
            "path", "Link phải có dạng https://www.tiktok.com/@tên_tài_khoản/live"
        )
    username = segments[0][1:]
    if not _USERNAME.match(username):
        raise InvalidLiveUrl("username", "Tên tài khoản trong link không hợp lệ.")
    rest = segments[1:]
    if rest not in ([], ["live"]):
        raise InvalidLiveUrl(
            "path", "Chỉ hỗ trợ link LIVE dạng https://www.tiktok.com/@tên_tài_khoản/live"
        )
    canonical = f"https://www.tiktok.com/@{username}/live"
    return ParsedLiveUrl(url=canonical, unique_id=username)
