"""Error log: every warning and error while the software runs, for the dashboard "Nhật ký lỗi".

A logging handler (root logger + uvicorn's own loggers) keeps the latest records in memory and
appends them to data/logs/errors.jsonl (rotated, about 12 MB at most), so the history survives a
restart. The browser pages report their JavaScript errors here too (/api/v1/logs/client).

* Secrets never reach the log: API keys, bearer tokens, JWTs and "token=…" are masked.
* The same error repeating within two minutes is one record with a counter, not a flood.
* Called from any thread; new records are pushed to the dashboard through the event loop."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import threading
import time
import traceback
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MAX_MEMORY = 2000
FILE_MAX_BYTES = 2 * 1024 * 1024
FILE_BACKUPS = 5
DEDUPE_WINDOW_S = 120.0
LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}

# logger name prefix → area shown to the shop owner (first match wins)
AREAS: tuple[tuple[str, str], ...] = (
    ("chibi.ai", "Trợ lý AI (Claude)"),
    ("chibi.voice", "Giọng đọc"),
    ("chibi.tiktok", "TikTok LIVE"),
    ("chibi.live", "Phiên LIVE"),
    ("chibi.ws", "Kết nối realtime"),
    ("chibi.orchestrator", "Xử lý bình luận"),
    ("chibi.client.game", "Trang game (OBS)"),
    ("chibi.client.dashboard", "Dashboard"),
    ("chibi.http", "API"),
    ("chibi.asyncio", "Tác vụ nền"),
    ("chibi.backup", "Sao lưu"),
    ("uvicorn", "Máy chủ web"),
    ("sqlalchemy", "Cơ sở dữ liệu"),
    ("alembic", "Cơ sở dữ liệu"),
    ("httpx", "Kết nối mạng"),
    ("TikTokLive", "TikTok LIVE"),
    ("chibi", "Hệ thống"),
)

_SECRETS = (
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{6,}"), "sk-ant-•••"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-~+/=]{8,}"), "Bearer •••"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}"), "•••jwt•••"),
    (re.compile(r"(?i)\b(api[_-]?key|token|password|passwd|secret|app[_-]?id|csrf[_-]?token)(\"?\s*[=:]\s*\"?)[^\s\"',;&}]{4,}"),
     r"\1\2•••"),
    (re.compile(r"(?i)(x-csrf-token|authorization|cookie)(\s*:\s*)[^\n]+"), r"\1\2•••"),
)


def redact(text: str) -> str:
    for rx, repl in _SECRETS:
        text = rx.sub(repl, text)
    return text


def area_of(logger_name: str) -> str:
    for prefix, area in AREAS:
        if logger_name == prefix or logger_name.startswith(prefix + "."):
            return area
    return "Thư viện ngoài"


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class ErrorRecord:
    id: int
    first_at: str
    last_at: str
    level: str
    area: str
    logger: str
    message: str
    detail: str | None = None  # traceback / stack
    count: int = 1
    context: dict[str, Any] = field(default_factory=dict)

    def key(self) -> tuple[str, str, str, str]:
        last = (self.detail or "").strip().splitlines()[-1:] or [""]
        return (self.logger, self.level, self.message[:200], last[0][:200])


class ErrorLog:
    def __init__(self, log_dir: Path, min_level: int = logging.WARNING):
        self.dir = log_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "errors.jsonl"
        self.min_level = min_level
        self.records: deque[ErrorRecord] = deque(maxlen=MAX_MEMORY)
        self._lock = threading.RLock()
        self._next_id = 1
        self._recent: dict[tuple[str, str, str, str], tuple[ErrorRecord, float]] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.publish: Callable[[ErrorRecord, bool], None] | None = None  # (record, is_new)
        self._emitting = threading.local()
        self.load()

    # ------------------------------------------------------------------ file
    def _files_oldest_first(self) -> list[Path]:
        olds = [self.dir / f"errors.jsonl.{i}" for i in range(FILE_BACKUPS, 0, -1)]
        return [p for p in [*olds, self.path] if p.exists()]

    def load(self) -> None:
        recs: dict[int, ErrorRecord] = {}
        for p in self._files_oldest_first():
            with contextlib.suppress(OSError):
                for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
                    with contextlib.suppress(ValueError, TypeError):
                        d = json.loads(line)
                        recs[int(d["id"])] = ErrorRecord(**d)  # later lines (updated counts) win
        with self._lock:
            for r in sorted(recs.values(), key=lambda r: r.id)[-MAX_MEMORY:]:
                self.records.append(r)
            self._next_id = (max(recs) + 1) if recs else 1

    def _write(self, r: ErrorRecord) -> None:
        try:
            if self.path.exists() and self.path.stat().st_size > FILE_MAX_BYTES:
                for i in range(FILE_BACKUPS, 0, -1):
                    src = self.dir / (f"errors.jsonl.{i - 1}" if i > 1 else "errors.jsonl")
                    if src.exists():
                        src.replace(self.dir / f"errors.jsonl.{i}")
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(asdict(r), ensure_ascii=False) + "\n")
        except OSError:
            pass  # a full disk must not break the LIVE

    # ------------------------------------------------------------------ adding
    def add(self, level: str, logger: str, message: str, detail: str | None = None,
            context: dict[str, Any] | None = None) -> ErrorRecord:
        level = level if level in LEVELS else "ERROR"
        message = redact(" ".join(str(message).split()))[:2000] or "(không có nội dung)"
        detail = redact(detail)[:20000] if detail else None
        ctx = {k: redact(str(v))[:300] for k, v in (context or {}).items() if v is not None}
        now = time.monotonic()
        with self._lock:
            probe = ErrorRecord(0, "", "", level, area_of(logger), logger, message, detail, 1, ctx)
            hit = self._recent.get(probe.key())
            if hit and now - hit[1] < DEDUPE_WINDOW_S:
                r = hit[0]
                r.count += 1
                r.last_at = now_iso()
                r.context = ctx or r.context  # the newest details (attempt, next retry…)
                self._recent[probe.key()] = (r, now)
                if r.count in (2, 5, 10) or r.count % 50 == 0:
                    self._write(r)
                is_new = False
            else:
                ts = now_iso()
                r = ErrorRecord(self._next_id, ts, ts, level, probe.area, logger, message, detail, 1, ctx)
                self._next_id += 1
                self.records.append(r)
                self._recent[probe.key()] = (r, now)
                if len(self._recent) > 500:
                    self._recent = {k: v for k, v in self._recent.items() if now - v[1] < DEDUPE_WINDOW_S}
                self._write(r)
                is_new = True
        self._push(r, is_new)
        return r

    def _push(self, r: ErrorRecord, is_new: bool) -> None:
        if self.publish is None or self.loop is None or self.loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self.publish(r, is_new)
        else:
            with contextlib.suppress(RuntimeError):
                self.loop.call_soon_threadsafe(self.publish, r, is_new)

    # ------------------------------------------------------------------ logging bridge
    def handler(self) -> logging.Handler:
        return _Handler(self)

    def install(self) -> None:
        """Attach to the root logger and uvicorn's (they do not propagate); replace an older one."""
        for name in ("", "uvicorn", "uvicorn.error"):
            lg = logging.getLogger(name)
            for h in list(lg.handlers):
                if isinstance(h, _Handler):
                    lg.removeHandler(h)
        h = self.handler()
        logging.getLogger().addHandler(h)
        uv = logging.getLogger("uvicorn")
        if not uv.propagate:
            uv.addHandler(h)

    def uninstall(self) -> None:
        for name in ("", "uvicorn", "uvicorn.error"):
            lg = logging.getLogger(name)
            for h in list(lg.handlers):
                if isinstance(h, _Handler) and h.store is self:
                    lg.removeHandler(h)

    # ------------------------------------------------------------------ reading
    def query(self, min_level: str = "WARNING", area: str | None = None, q: str | None = None,
              since_id: int | None = None, limit: int = 300) -> list[ErrorRecord]:
        lv = LEVELS.get(min_level, 30)
        ql = (q or "").lower()
        with self._lock:
            items = list(self.records)
        out = []
        for r in reversed(items):
            if LEVELS.get(r.level, 40) < lv or (area and r.area != area) or (since_id and r.id <= since_id):
                continue
            if ql and ql not in r.message.lower() and ql not in (r.detail or "").lower() and ql not in r.area.lower():
                continue
            out.append(r)
            if len(out) >= limit:
                break
        return out

    def stats(self, seen_id: int) -> dict[str, Any]:
        cutoff = datetime.now(UTC).timestamp() - 86400
        by_area: dict[str, int] = {}
        errors = warnings = unseen = 0
        with self._lock:
            items = list(self.records)
        for r in items:
            if r.id > seen_id and LEVELS.get(r.level, 40) >= 30:
                unseen += 1
            try:
                recent = datetime.fromisoformat(r.last_at).timestamp() >= cutoff
            except ValueError:
                recent = False
            if recent:
                by_area[r.area] = by_area.get(r.area, 0) + r.count
                if LEVELS.get(r.level, 40) >= 40:
                    errors += r.count
                elif r.level == "WARNING":
                    warnings += r.count
        return {"unseen": unseen, "last_id": self._next_id - 1, "errors_24h": errors, "warnings_24h": warnings,
                "by_area_24h": dict(sorted(by_area.items(), key=lambda kv: -kv[1]))}

    def clear(self) -> None:
        with self._lock:
            self.records.clear()
            self._recent.clear()
            for p in self._files_oldest_first():
                with contextlib.suppress(OSError):
                    p.unlink()

    def export_text(self) -> str:
        with self._lock:
            items = list(self.records)
        lines = []
        for r in items:
            times = f"{r.first_at}" + (f" → {r.last_at} (×{r.count})" if r.count > 1 else "")
            lines.append(f"#{r.id} [{r.level}] {times} {r.area} ({r.logger}): {r.message}")
            for k, v in r.context.items():
                lines.append(f"    {k}: {v}")
            if r.detail:
                lines.extend("    " + ln for ln in r.detail.rstrip().splitlines())
        return "\n".join(lines) + "\n"


class _Handler(logging.Handler):
    def __init__(self, store: ErrorLog):
        super().__init__(level=store.min_level)
        self.store = store

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(self.store._emitting, "on", False):
            return
        self.store._emitting.on = True
        try:
            if record.name == "uvicorn.access":
                return
            detail = None
            if record.exc_info and record.exc_info[0] is not None:
                detail = "".join(traceback.format_exception(*record.exc_info))
            elif record.stack_info:
                detail = record.stack_info
            ctx = getattr(record, "ctx", None)
            self.store.add(record.levelname, record.name, record.getMessage(), detail,
                           ctx if isinstance(ctx, dict) else None)
        except Exception:  # noqa: BLE001, S110 — the log itself must never raise into the caller
            pass
        finally:
            self.store._emitting.on = False
