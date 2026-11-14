"""Vbee text-to-speech (https://api-docs.vbee.vn), Realtime API in `sync` mode.

POST https://api.vbee.vn/v1/tts with `Authorization: Bearer <token>` and `App-Id: <app id>`,
body {text ≤ 300 chars, voiceCode, outputFormat, bitrate, speed, mode: "sync"}; the response
body is the audio itself, so no public callback URL is needed (this app runs on the shop's PC).
Longer texts are split at sentence/comma boundaries and the MP3 pieces are concatenated."""

from __future__ import annotations

import io
import math
import re
import struct
import wave
from dataclasses import dataclass
from typing import Protocol

import httpx

VBEE_URL = "https://api.vbee.vn/v1/tts"
VOICES_URL = "https://vbee.vn/api/public/v1/voices"  # "Get list voices" (api-docs.vbee.vn)
MAX_VOICE_PAGES = 15
MAX_CHARS = 300
TIMEOUT_S = 15.0


class TtsError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Audio:
    data: bytes
    ext: str  # "mp3" | "wav"
    mime: str


class TtsProvider(Protocol):
    name: str

    async def synth(self, text: str, voice: str, speed: float) -> Audio: ...


def split_text(text: str, limit: int = MAX_CHARS) -> list[str]:
    """Pieces ≤ limit characters, cut after . ! ? then , ; : then spaces."""
    text = " ".join(text.split())
    out: list[str] = []
    while len(text) > limit:
        cut = -1
        for pattern in (r"[.!?…](?=\s)", r"[,;:](?=\s)", r"\s"):
            hits = [m.end() for m in re.finditer(pattern, text[: limit + 1])]
            if hits:
                cut = hits[-1]
                break
        if cut <= 0:
            cut = limit
        out.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        out.append(text)
    return out


class VbeeTts:
    name = "vbee"

    def __init__(self, app_id: str, token: str, transport: httpx.AsyncBaseTransport | None = None):
        self.app_id = app_id
        self.token = token
        self.transport = transport

    async def _one(self, client: httpx.AsyncClient, text: str, voice: str, speed: float) -> bytes:
        body = {"text": text, "voiceCode": voice, "outputFormat": "mp3", "bitrate": 128,
                "speed": round(speed, 2), "mode": "sync"}
        headers = {"Authorization": f"Bearer {self.token}", "App-Id": self.app_id,
                   "Content-Type": "application/json"}
        try:
            r = await client.post(VBEE_URL, json=body, headers=headers)
        except httpx.TimeoutException as exc:
            raise TtsError("timeout", "Vbee trả lời quá lâu.") from exc
        except httpx.HTTPError as exc:
            raise TtsError("network", "Không kết nối được tới Vbee.") from exc
        ctype = r.headers.get("content-type", "")
        if r.status_code == 200 and "json" not in ctype and r.content:
            return r.content
        message = ""
        try:
            message = str(r.json().get("error", {}).get("message", ""))
        except ValueError:
            pass
        if r.status_code == 401:
            raise TtsError("auth", "Sai App ID hoặc Token Vbee (hoặc token đã hết hạn).")
        if r.status_code == 429:
            raise TtsError("busy", "Vbee đang quá nhiều yêu cầu cùng lúc — thử lại sau.")
        if r.status_code == 400:
            if "credit" in message.lower():
                raise TtsError("credit", "Tài khoản Vbee đã hết ký tự/credit.")
            if "voice" in message.lower():
                raise TtsError("voice", "Mã giọng đọc không tồn tại trên Vbee.")
            raise TtsError("bad_request", f"Vbee từ chối yêu cầu: {message or 'dữ liệu không hợp lệ'}.")
        raise TtsError("api", f"Vbee lỗi {r.status_code}{': ' + message if message else ''}.")

    async def synth(self, text: str, voice: str, speed: float) -> Audio:
        if not self.app_id or not self.token:
            raise TtsError("not_configured", "Chưa nhập App ID và Token Vbee.")
        parts = split_text(text)
        async with httpx.AsyncClient(timeout=TIMEOUT_S, transport=self.transport) as client:
            chunks = [await self._one(client, p, voice, speed) for p in parts]
        return Audio(b"".join(chunks), "mp3", "audio/mpeg")


@dataclass
class Voice:
    code: str
    name: str
    gender: str | None
    language_code: str | None
    demo: str | None
    credit_factor: float | None
    ownership: str | None

    def as_dict(self) -> dict:
        return self.__dict__.copy()


# Vbee's page for "Get list voices" names the query parameters in snake_case in its table but
# uses camelCase in its own example (?voiceOwnership=VBEE&languageCode=vi-VN). Try the example's
# form first, then the others, and keep the first one Vbee accepts.
_PARAM_STYLES: tuple[tuple[str, str | None, str | None, str | None], ...] = (
    # (name, language key, ownership key, ownership value for the first pass)
    ("camel", "languageCode", "voiceOwnership", None),
    ("camel+vbee", "languageCode", "voiceOwnership", "VBEE"),  # exactly the documented example
    ("snake", "language_code", "voice_ownership", None),
    ("bare", None, None, None),
)


def _vbee_message(r: httpx.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return r.text[:160].strip()
    if isinstance(body, dict):
        err = body.get("error")
        for v in (body.get("error_message"), body.get("message"), err.get("message") if isinstance(err, dict) else err,
                  body.get("errors")):
            if v:
                return str(v)[:160]
    return ""


async def list_voices(app_id: str, token: str, language_code: str | None = "vi-VN",
                      transport: httpx.AsyncBaseTransport | None = None) -> list[Voice]:
    """Every voice this app may use: Vbee's own, community and the account's personal voices.
    GET https://vbee.vn/api/public/v1/voices with cursor pagination."""
    if not app_id or not token:
        raise TtsError("not_configured", "Chưa nhập App ID và Token Vbee.")
    headers = {"Authorization": f"Bearer {token}", "App-Id": app_id}
    found: dict[str, Voice] = {}

    async def get(client: httpx.AsyncClient, params: dict[str, str]) -> httpx.Response:
        try:
            return await client.get(VOICES_URL, params=params, headers=headers)
        except httpx.TimeoutException as exc:
            raise TtsError("timeout", "Vbee trả lời quá lâu.") from exc
        except httpx.HTTPError as exc:
            raise TtsError("network", "Không kết nối được tới Vbee.") from exc

    def take(r: httpx.Response, ownership: str | None) -> str | None:
        try:
            body = r.json()
            if isinstance(body, dict) and body.get("status") == 0:
                raise TtsError("api", f"Vbee từ chối: {_vbee_message(r) or 'không rõ lý do'}.")
            result = body.get("result") or {}
            voices = result.get("voices") or []
            page = result.get("pagination") or {}
        except (ValueError, AttributeError) as exc:
            raise TtsError("api", "Vbee trả về danh sách giọng không đúng định dạng.") from exc
        for v in voices:
            code = str(v.get("code") or "").strip()
            if not code:
                continue
            if language_code and v.get("language_code") and v["language_code"] != language_code:
                continue  # the "bare" form may return every language
            voice = found.setdefault(code, Voice(
                code=code, name=str(v.get("name") or code), gender=v.get("gender"),
                language_code=v.get("language_code"), demo=v.get("demo") or None,
                credit_factor=v.get("credit_factor"), ownership=ownership or v.get("voice_ownership")))
            if ownership and voice.ownership in (None, "VBEE"):
                voice.ownership = ownership
        return page.get("next_cursor") if page.get("has_next_page") else None

    async with httpx.AsyncClient(timeout=TIMEOUT_S, transport=transport) as client:
        style = None
        first: httpx.Response | None = None
        errors: list[str] = []
        for st in _PARAM_STYLES:
            _, lang_key, own_key, own_value = st
            params = {}
            if lang_key and language_code:
                params[lang_key] = language_code
            if own_key and own_value:
                params[own_key] = own_value
            r = await get(client, params)
            if r.status_code == 401:
                raise TtsError("auth", "Sai App ID hoặc Token Vbee (hoặc token đã hết hạn).")
            if r.status_code == 200:
                style, first = st, r
                break
            errors.append(f"{r.status_code} {_vbee_message(r)}".strip())
        if style is None or first is None:
            detail = errors[0] if errors else ""
            raise TtsError("api", f"Vbee từ chối lấy danh sách giọng ({detail}).")
        _, lang_key, own_key, own_value = style

        async def walk(r: httpx.Response, base: dict[str, str], ownership: str | None) -> None:
            cursor = take(r, ownership)
            for _ in range(MAX_VOICE_PAGES):
                if not cursor:
                    return
                r = await get(client, {**base, "cursor": cursor})
                if r.status_code != 200:
                    return
                cursor = take(r, ownership)

        base: dict[str, str] = {}
        if lang_key and language_code:
            base[lang_key] = language_code
        if own_key and own_value:
            base[own_key] = own_value
        await walk(first, base, own_value)
        # the account's own and community voices, when the API filters by ownership (best effort)
        if own_key:
            for ownership in ("PERSONAL", "COMMUNITY"):
                b = {**base, own_key: ownership}
                r = await get(client, b)
                if r.status_code == 200:
                    try:
                        await walk(r, b, ownership)
                    except TtsError:
                        pass
    return sorted(found.values(), key=lambda v: (v.ownership != "PERSONAL", v.gender or "", v.name.lower()))


class FakeTts:
    """Offline stand-in for demos and tests (CHIBI_FAKE_AI=1): a soft beep per sentence."""

    name = "fake"

    async def synth(self, text: str, voice: str, speed: float) -> Audio:
        rate = 16000
        seconds = min(4.0, 0.4 + len(text) / 40)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            frames = bytearray()
            for i in range(int(rate * seconds)):
                env = min(1.0, i / 800, (rate * seconds - i) / 800)
                frames += struct.pack("<h", int(1800 * env * math.sin(2 * math.pi * 440 * i / rate)))
            w.writeframes(bytes(frames))
        return Audio(buf.getvalue(), "wav", "audio/wav")
