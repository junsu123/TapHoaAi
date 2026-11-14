"""SpeechQueue: what the LIVE hears, one clip at a time (AI-04, AI-06, G3).

Clips are synthesized ahead (and cached on disk by text+voice+speed) and handed to the primary
game page — the OBS browser source — which plays them and reports SPEECH_STARTED/SPEECH_ENDED.
The next clip starts only after the previous one ended, never while the host holds the floor
(SPEECH_HOLD, "Tôi đang nói"), and nothing plays after the kill switch until the host turns the
voice back on. Clips that waited too long are dropped: an answer one minute late is noise."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import itertools
import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from app.services.tts_vbee import TtsError, TtsProvider

if TYPE_CHECKING:
    from app.websocket.hub import Hub

log = logging.getLogger("chibi.voice")

STALE_SECONDS = 90.0
CHARS_PER_SECOND = 12.0  # Vietnamese TTS at speed 1.0, a little slow on purpose (timeout only)
CACHE_KEEP_DAYS = 3
Kind = Literal["question", "answer", "test"]
LABELS = {"question": "Câu hỏi của khách", "answer": "Trợ lý AI", "test": "Thử giọng"}


@dataclass
class Clip:
    id: str
    kind: Kind
    text: str
    ref: str | None
    created: float = field(default_factory=time.monotonic)
    url: str | None = None
    status: str = "đang tạo giọng"  # đang tạo giọng | chờ phát | đang phát | đã phát | đã dừng | bỏ (…)
    error: str | None = None
    started: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False, compare=False)

    def wire(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "label": LABELS[self.kind], "text": self.text, "url": self.url}

    def summary(self) -> dict[str, Any]:
        return {**self.wire(), "ref": self.ref, "status": self.status, "error": self.error}


class SpeechQueue:
    def __init__(self, hub: Hub, cache_dir: Path):
        self.hub = hub
        self.cache_dir = cache_dir
        cache_dir.mkdir(parents=True, exist_ok=True)
        self.provider: TtsProvider | None = None
        self.voice = ""
        self.speed = 1.0
        self.muted = False
        self.hold = False
        self.queue: deque[Clip] = deque()
        self.current: Clip | None = None
        self.history: deque[Clip] = deque(maxlen=30)
        self._ids = itertools.count(1)
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None
        self.on_chars: Callable[[int], None] = lambda n: None

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self._task = asyncio.create_task(self._pump(), name="speech-queue")
        self.prune_cache()

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def prune_cache(self) -> None:
        cutoff = time.time() - CACHE_KEEP_DAYS * 86400
        for p in self.cache_dir.glob("*.*"):
            with contextlib.suppress(OSError):
                if p.stat().st_mtime < cutoff:
                    p.unlink()

    # ------------------------------------------------------------------ state
    def state(self) -> dict[str, Any]:
        return {"muted": self.muted, "hold": self.hold, "player": self.hub.has_primary(),
                "current": self.current.summary() if self.current else None,
                "queue": [c.summary() for c in self.queue],
                "history": [c.summary() for c in list(self.history)[::-1][:12]]}

    def _publish(self) -> None:
        self.hub.send_dashboard({"type": "SPEECH_STATE", "speech": self.state()})

    # ------------------------------------------------------------------ synthesis
    async def render(self, text: str, provider: TtsProvider | None = None, voice: str | None = None,
                     speed: float | None = None) -> str:
        """Audio file URL for this text (cached); raises TtsError."""
        provider = provider or self.provider
        voice = voice or self.voice
        speed = speed or self.speed
        if provider is None:
            raise TtsError("not_configured", "Chưa cấu hình giọng đọc Vbee.")
        key = hashlib.sha256(f"{provider.name}|{voice}|{speed}|{text}".encode()).hexdigest()[:32]
        for ext in ("mp3", "wav"):
            p = self.cache_dir / f"{key}.{ext}"
            if p.exists():
                p.touch()
                return f"/tts/{p.name}"
        audio = await provider.synth(text, voice, speed)
        self.on_chars(len(text))
        p = self.cache_dir / f"{key}.{audio.ext}"
        tmp = p.with_suffix(".part")
        tmp.write_bytes(audio.data)
        tmp.replace(p)
        return f"/tts/{p.name}"

    def enqueue(self, kind: Kind, text: str, ref: str | None = None) -> Clip | None:
        """Queue a clip now (keeps the order of calls) and make its audio in the background.
        None when the voice is muted. `clip.task` finishes when the audio is ready or failed."""
        if self.muted:
            return None
        clip = Clip(id=f"s{next(self._ids)}", kind=kind, text=text, ref=ref)
        self.queue.append(clip)
        self._publish()
        clip.task = asyncio.create_task(self._render_clip(clip))
        return clip

    async def say(self, kind: Kind, text: str, ref: str | None = None) -> Clip | None:
        clip = self.enqueue(kind, text, ref)
        if clip is not None and clip.task is not None:
            await clip.task
        return clip

    async def _render_clip(self, clip: Clip) -> None:
        try:
            clip.url = await self.render(clip.text)
            if clip in self.queue:
                clip.status = "chờ phát"
        except TtsError as exc:
            if clip in self.queue:
                clip.status, clip.error = "bỏ (lỗi giọng đọc)", exc.message
                self._drop(clip)
            log.warning("tts failed: %s", exc.code)
        except Exception as exc:
            clip.status, clip.error = "bỏ (lỗi giọng đọc)", str(exc)[:120]
            self._drop(clip)
            log.exception("tts failed")
        self._publish()
        self._wake.set()

    def _drop(self, clip: Clip) -> None:
        with contextlib.suppress(ValueError):
            self.queue.remove(clip)
        if clip not in self.history:
            self.history.append(clip)

    # ------------------------------------------------------------------ controls
    def kill(self, mute: bool = True) -> None:
        """Kill switch: stop now, forget everything queued, stay silent until unmuted
        (mute=False: just stop and clear, e.g. when the AI is paused)."""
        self.muted = self.muted or mute
        for clip in list(self.queue):
            clip.status = "đã dừng"
            self._drop(clip)
        if self.current:
            self.current.status = "đã dừng"
            self.history.append(self.current)
            self.current = None
        self.hub.send_game({"type": "SPEECH_STOP"})
        self._publish()

    def unmute(self) -> None:
        self.muted = False
        self._publish()
        self._wake.set()

    def set_hold(self, hold: bool) -> None:
        if hold == self.hold:
            return
        self.hold = hold
        if not hold and self.current is not None and self.current.started is not None:
            self.current.started = time.monotonic()  # the paused clip gets its full time again
        self.hub.send_game({"type": "SPEECH_HOLD", "hold": hold})
        self._publish()
        self._wake.set()

    # ------------------------------------------------------------------ player feedback
    def on_client_message(self, msg: dict[str, Any]) -> None:
        cid = msg.get("id")
        cur = self.current
        if cur is None or cid != cur.id:
            return
        if msg.get("type") == "SPEECH_STARTED":
            cur.status = "đang phát"
        elif msg.get("type") in ("SPEECH_ENDED", "SPEECH_FAILED"):
            cur.status = "đã phát" if msg["type"] == "SPEECH_ENDED" else "bỏ (máy phát lỗi)"
            if msg["type"] == "SPEECH_FAILED":
                cur.error = str(msg.get("reason") or "")[:120]
            self.history.append(cur)
            self.current = None
            self._wake.set()
        self._publish()

    # ------------------------------------------------------------------ pump
    def _ready(self) -> Clip | None:
        now = time.monotonic()
        for clip in list(self.queue):
            if now - clip.created > STALE_SECONDS:
                clip.status = "bỏ (chờ quá lâu)"
                self._drop(clip)
        for clip in self.queue:
            if clip.url:
                return clip
            break  # keep order: wait for the head to finish rendering
        return None

    async def _pump(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=1.0)
            except TimeoutError:
                pass
            self._wake.clear()
            try:
                self._step()
            except Exception:
                log.exception("speech pump failed")

    def _step(self) -> None:
        now = time.monotonic()
        cur = self.current
        if cur is not None:
            limit = 8.0 + len(cur.text) / CHARS_PER_SECOND / max(self.speed, 0.5)
            if cur.started is not None and not self.hold and now - cur.started > limit:
                cur.status = "đã phát (không nhận được báo kết thúc)"
                self.history.append(cur)
                self.current = None
                self._publish()
            return
        if self.muted or self.hold:
            return
        clip = self._ready()
        if clip is None:
            return
        if not self.hub.has_primary():
            if now - clip.created > 15:
                clip.status = "bỏ (chưa mở trang game/OBS)"
                self._drop(clip)
                self._publish()
            return
        self.queue.remove(clip)
        clip.started = now
        clip.status = "đang gửi tới OBS"
        self.current = clip
        self.hub.send_game({"type": "SPEECH", "clip": clip.wire()})
        self._publish()
