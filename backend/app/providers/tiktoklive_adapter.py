"""TikTok LIVE adapter (M3) built on the unofficial TikTokLive library.

* Optional dependency: `pip install -e "backend[tiktok]"`. Without it the provider reports
  `Không hỗ trợ` with an install hint — it never pretends to connect (LIVE-02).
* Licence: TikTokLive is "Modified AGPL-3.0". Its §18 allows use inside a LIVE game /
  overlay / bot without adopting AGPL; §19 removes that permission for SaaS, hosted or
  relay services offered to third parties. Running this app for your own shop is the §18
  case; selling it as a hosted service is not. (Not legal advice — see docs/provider-limitations.md.)
* Privacy: to connect, TikTokLive asks a third-party signing server (Euler Stream) to sign
  the request, so the streamer's @handle is sent there. No viewer data is sent.
* No CAPTCHA solving, no cookies/session ids, no block evasion: when TikTok blocks or the
  LIVE is age-restricted, the real reason is shown and the operator can switch to Demo.

TikTokLive types never leave this module: every event becomes a plain raw dict (SPEC F1).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import Counter
from collections.abc import Callable
from typing import Any

from app.providers.live_provider import Capability, LiveEventProvider, ProviderStatus

log = logging.getLogger("chibi.tiktok")

CAPABILITY_KEYS = ("comment", "join", "like", "follow", "share", "gift", "viewer_count")


class ProviderTerminal(Exception):
    """A failure that retrying cannot fix (offline, blocked, not found…)."""


def _get(obj: Any, *names: str) -> Any:
    for n in names:
        try:
            v = getattr(obj, n)
        except Exception:  # noqa: BLE001 - betterproto properties may raise on unset fields
            continue
        if v not in (None, "", 0):
            return v
    return None


def map_user(user: Any) -> dict[str, str | None] | None:
    if user is None:
        return None
    uid = _get(user, "id", "user_id", "id_str")
    handle = _get(user, "display_id", "unique_id", "username")
    nick = _get(user, "nickname", "nick_name")
    if not (uid or handle or nick):
        return None
    return {"platform_user_id": str(uid) if uid else None, "unique_id": handle, "nickname": nick}


def _event_id(ev: Any) -> str | None:
    common = _get(ev, "common", "event", "base_message")
    msg_id = _get(common, "msg_id") if common is not None else None
    return f"tt_{msg_id}" if msg_id else None


def map_event(ev: Any) -> dict[str, Any] | None:
    """TikTokLive event object → raw dict for the normalizer (None = not used)."""
    kind = type(ev).__name__
    base: dict[str, Any] = {"event_id": _event_id(ev), "_received_monotonic": time.monotonic()}
    if kind == "CommentEvent":
        text = _get(ev, "content", "comment")
        if not text:
            return None
        return {**base, "type": "COMMENT", "user": map_user(_get(ev, "user")), "payload": {"text": text}}
    if kind == "GiftEvent":
        gift = _get(ev, "gift")
        streakable = bool(gift is not None and getattr(gift, "type", None) == 1)
        streaking = bool(getattr(ev, "streaking", False))
        group = _get(ev, "group_id")
        return {**base, "type": "GIFT", "user": map_user(_get(ev, "user")), "payload": {
            "gift_id": str(_get(gift, "id") or _get(ev, "gift_id") or ""),
            "gift_name": _get(gift, "name") if gift is not None else None,
            "repeat_count": int(_get(ev, "repeat_count") or 1),
            "repeat_end": not streaking, "streakable": streakable,
            "group_id": str(group) if (group and streakable) else None,
        }}
    if kind == "LikeEvent":
        return {**base, "type": "LIKE", "user": map_user(_get(ev, "user")),
                "payload": {"count": int(_get(ev, "count", "like_count") or 1)}}
    if kind == "JoinEvent":
        return {**base, "type": "JOIN", "user": map_user(_get(ev, "user")), "payload": {}}
    if kind == "FollowEvent":
        return {**base, "type": "FOLLOW", "user": map_user(_get(ev, "user")), "payload": {}}
    if kind == "ShareEvent":
        return {**base, "type": "SHARE", "user": map_user(_get(ev, "user")), "payload": {}}
    if kind == "RoomUserSeqEvent":
        total = _get(ev, "total", "viewer_count", "total_user")
        return None if total is None else {**base, "type": "VIEWER_COUNT", "payload": {"count": int(total)}}
    return None


_CAP_OF = {"COMMENT": "comment", "JOIN": "join", "LIKE": "like", "FOLLOW": "follow", "SHARE": "share",
           "GIFT": "gift", "VIEWER_COUNT": "viewer_count"}


def default_client_factory(unique_id: str, sign_api_key: str | None):
    from TikTokLive import TikTokLiveClient  # lazy: optional dependency

    web_kwargs: dict[str, Any] = {}
    if sign_api_key:
        web_kwargs["signer_kwargs"] = {"sign_api_key": sign_api_key}
    return TikTokLiveClient(unique_id=unique_id, web_kwargs=web_kwargs)


class TikTokLiveAdapter(LiveEventProvider):
    name = "tiktok_unofficial"

    def __init__(self, unique_id: str, *, sign_api_key: str | None = None,
                 client_factory: Callable[[str, str | None], Any] | None = None):
        super().__init__()
        self.unique_id = unique_id
        self.sign_api_key = sign_api_key
        self.client_factory = client_factory or default_client_factory
        self.client: Any = None
        self.seen: Counter[str] = Counter()
        self.connected_at: float | None = None
        self._ended = False
        self._stopping = False

    # ------------------------------------------------------------------ capabilities
    def capabilities(self) -> dict[str, Capability]:
        """`available` once an event of that kind was really observed in this session;
        `unknown` otherwise — absence of events is not proof that TikTok stopped sending them."""
        return {k: (Capability.AVAILABLE if self.seen[k] else Capability.UNKNOWN) for k in CAPABILITY_KEYS}

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        self._ended = False
        await self._set_status(ProviderStatus.CHECKING, f"Đang kiểm tra @{self.unique_id}…")
        try:
            errors = self._error_classes()
        except ImportError:
            await self._set_status(ProviderStatus.UNSUPPORTED,
                                   'Chưa cài thư viện TikTokLive. Chạy: pip install -e "backend[tiktok]" rồi khởi động lại.')
            return
        try:
            self.client = self.client_factory(self.unique_id, self.sign_api_key)
            self._register(self.client)
            await self._set_status(ProviderStatus.CONNECTING, None)
            task = await self.client.start(fetch_live_check=True)
        except errors["offline"]:
            await self._set_status(ProviderStatus.OFFLINE, f"@{self.unique_id} hiện không phát LIVE.")
            return
        except errors["not_found"]:
            await self._set_status(ProviderStatus.UNSUPPORTED,
                                   f"Không tìm thấy @{self.unique_id} hoặc tài khoản chưa đủ điều kiện phát LIVE.")
            return
        except errors["age"]:
            await self._set_status(ProviderStatus.UNSUPPORTED,
                                   "LIVE bị giới hạn độ tuổi. Hệ thống không dùng cookie đăng nhập nên không đọc được phòng này.")
            return
        except errors["premium"]:
            await self._set_status(ProviderStatus.UNSUPPORTED,
                                   "Máy chủ ký yêu cầu gói trả phí cho thao tác này. Nhập khóa API hoặc dùng Demo.")
            return
        except errors["blocked"]:
            await self._set_status(ProviderStatus.UNSUPPORTED,
                                   "TikTok đang chặn kết nối từ máy này. Hệ thống không vượt chặn — thử lại sau hoặc dùng Demo.")
            return
        except errors["rate_limit"] as exc:
            raise ConnectionError("Máy chủ ký (Euler Stream) đang giới hạn lượt kết nối — sẽ thử lại.") from exc
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - network/DNS/TLS/unknown upstream changes
            raise ConnectionError(
                f"Không kết nối được tới TikTok hoặc máy chủ ký ({type(exc).__name__}). "
                "Kiểm tra mạng; nếu lỗi kéo dài, thư viện có thể cần cập nhật."
            ) from exc
        self.room_id = str(getattr(self.client, "room_id", "") or "") or None
        self.connected_at = time.monotonic()
        await self._set_status(ProviderStatus.CONNECTED, f"Phòng {self.room_id}" if self.room_id else None)
        try:
            await task  # returns when the websocket closes
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            if not (self._ended or self._stopping):
                raise ConnectionError(f"Mất kết nối WebSocket: {type(exc).__name__}") from exc
        if self._ended:
            await self._set_status(ProviderStatus.ENDED, "Buổi LIVE đã kết thúc.")

    async def stop(self) -> None:
        self._stopping = True
        if self.client is not None:
            with contextlib.suppress(Exception):
                await self.client.disconnect(close_client=True)
        await self._set_status(ProviderStatus.DISCONNECTED)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _error_classes() -> dict[str, tuple[type[BaseException], ...]]:
        from TikTokLive.client import errors as e  # lazy

        def pick(*names: str) -> tuple[type[BaseException], ...]:
            return tuple(getattr(e, n) for n in names if hasattr(e, n)) or (RuntimeError,)

        return {
            "offline": pick("UserOfflineError"),
            "not_found": pick("UserNotFoundError"),
            "age": pick("AgeRestrictedError"),
            "premium": pick("PremiumEndpointError", "AuthenticatedWebSocketConnectionError"),
            "blocked": pick("WebcastBlockedError", "InitialCursorMissingError", "WebsocketURLMissingError"),
            "rate_limit": pick("SignatureRateLimitError"),
        }

    def _register(self, client: Any) -> None:
        from TikTokLive import events as ev  # lazy

        async def forward(event: Any) -> None:
            raw = map_event(event)
            if raw is None:
                return
            cap = _CAP_OF.get(raw["type"])
            if cap:
                self.seen[cap] += 1
            await self._emit(raw)

        async def on_end(_event: Any) -> None:
            self._ended = True
            await self._emit({"type": "LIVE_END", "event_id": None, "payload": {}})
            with contextlib.suppress(Exception):
                await client.disconnect()

        for name in ("CommentEvent", "GiftEvent", "LikeEvent", "JoinEvent", "FollowEvent", "ShareEvent",
                     "RoomUserSeqEvent"):
            cls = getattr(ev, name, None)
            if cls is not None:
                client.add_listener(cls, forward)
        if hasattr(ev, "LiveEndEvent"):
            client.add_listener(ev.LiveEndEvent, on_end)
