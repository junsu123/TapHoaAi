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


# ---------------------------------------------------------------- short links (M3)
MAX_REDIRECTS = 3


async def _host_is_public(host: str) -> bool:
    import asyncio
    import ipaddress
    import socket

    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return bool(infos)


async def resolve_short_link(url: str, *, client=None, host_check=None) -> ParsedLiveUrl:
    """Follow a vm./vt.tiktok.com link by hand: at most 3 redirects, HEAD/GET without body,
    every hop re-checked against the TikTok allowlist and refused if it resolves to a
    private address (NFR-05). Returns the parsed final LIVE URL."""
    import httpx

    host_check = host_check or _host_is_public
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=8.0, follow_redirects=False,
                                         headers={"User-Agent": "Mozilla/5.0 (ChibiLiveShop link check)"})
    try:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            parts = urlsplit(current)
            host = (parts.hostname or "").lower()
            if parts.scheme != "https" or host not in ALLOWED_HOSTS | SHORT_LINK_HOSTS:
                raise InvalidLiveUrl("redirect_host", "Link rút gọn dẫn ra ngoài tiktok.com — đã chặn.")
            if host in ALLOWED_HOSTS:
                return parse_live_url(current)
            if not await host_check(host):
                raise InvalidLiveUrl("redirect_host", "Không phân giải được tên miền an toàn cho link rút gọn.")
            try:
                resp = await client.get(current)
            except httpx.HTTPError as exc:
                raise InvalidLiveUrl("short_link_unreachable", "Không mở được link rút gọn. Hãy dán link dạng https://www.tiktok.com/@tên/live") from exc
            location = resp.headers.get("location")
            if resp.status_code not in (301, 302, 303, 307, 308) or not location:
                raise InvalidLiveUrl("short_link_dead", "Link rút gọn không chuyển tới trang LIVE nào.")
            current = str(httpx.URL(current).join(location))
        raise InvalidLiveUrl("too_many_redirects", "Link rút gọn chuyển hướng quá nhiều lần.")
    finally:
        if own_client:
            await client.aclose()
