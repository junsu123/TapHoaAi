"""Game page performance (spec V3 §10, T16).

The OBS page reports FPS, slow frames, Chibi logic time, draw calls, memory and graphics card
every 5 seconds. A benchmark run adds N demo Chibis and, after a short warm-up, summarises the
reports of the next 20 seconds — so the shop owner can measure 30 / 50 Chibis on the real PC.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Any

WARMUP_S = 8.0
MEASURE_S = 20.0


def _num(v: Any, lo: float = 0.0, hi: float = 1e9) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return max(lo, min(hi, float(v)))


def clean_report(msg: dict[str, Any]) -> dict[str, Any]:
    lod = msg.get("lod") if isinstance(msg.get("lod"), dict) else {}
    return {
        "fps": _num(msg.get("fps"), 0, 500),
        "frame_ms_p95": _num(msg.get("frame_ms_p95"), 0, 10_000),
        "sim_ms": _num(msg.get("sim_ms"), 0, 10_000),
        "render_calls": _num(msg.get("render_calls"), 0, 1e7),
        "triangles": _num(msg.get("triangles"), 0, 1e9),
        "heap_mb": _num(msg.get("heap_mb"), 0, 1e6),
        "gpu": str(msg.get("gpu"))[:120] if msg.get("gpu") else None,
        "quality": str(msg.get("quality") or "")[:12],
        "avatars": int(_num(msg.get("avatars"), 0, 10_000) or 0),
        "lod": {k: int(_num(lod.get(k), 0, 10_000) or 0) for k in ("full", "reduced", "far", "hidden")},
        "at": time.time(),
    }


@dataclass
class BenchRun:
    target: int
    started: float
    reports: list[dict[str, Any]] = field(default_factory=list)
    done: bool = False

    def summary(self) -> dict[str, Any]:
        rs = self.reports
        fps = [r["fps"] for r in rs if r["fps"] is not None]
        p95 = [r["frame_ms_p95"] for r in rs if r["frame_ms_p95"] is not None]
        heap = [r["heap_mb"] for r in rs if r["heap_mb"] is not None]
        last = rs[-1] if rs else {}
        return {
            "target": self.target,
            "avatars": max((r["avatars"] for r in rs), default=0),
            "samples": len(rs),
            "fps_avg": round(sum(fps) / len(fps), 1) if fps else None,
            "fps_min": round(min(fps), 1) if fps else None,
            "frame_ms_p95": round(max(p95), 1) if p95 else None,
            "sim_ms": round(sum(r["sim_ms"] or 0 for r in rs) / len(rs), 2) if rs else None,
            "render_calls": int(sum(r["render_calls"] or 0 for r in rs) / len(rs)) if rs else None,
            "triangles": int(sum(r["triangles"] or 0 for r in rs) / len(rs)) if rs else None,
            "heap_mb": round(max(heap), 1) if heap else None,
            "gpu": last.get("gpu"),
            "quality": last.get("quality"),
            "lod": last.get("lod"),
            "done": self.done,
            "started_at": self.started,
        }


class PerfMonitor:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.reports: deque[dict[str, Any]] = deque(maxlen=60)
        self.run: BenchRun | None = None
        self.results: deque[dict[str, Any]] = deque(maxlen=10)

    @property
    def last(self) -> dict[str, Any] | None:
        return self.reports[-1] if self.reports else None

    def add(self, msg: dict[str, Any]) -> None:
        r = clean_report(msg)
        self.reports.append(r)
        run = self.run
        if run and not run.done:
            age = self.clock() - run.started
            if age >= WARMUP_S:
                run.reports.append(r)
            if age >= WARMUP_S + MEASURE_S and run.reports:
                run.done = True
                self.results.append(run.summary())

    def start(self, target: int) -> None:
        if self.run and not self.run.done and self.run.reports:
            self.results.append(self.run.summary())  # keep what was measured so far
        self.run = BenchRun(target=target, started=self.clock())

    def view(self) -> dict[str, Any]:
        return {
            "last": self.last,
            "history": [{"fps": r["fps"], "avatars": r["avatars"], "at": r["at"]} for r in self.reports],
            "running": self.run.summary() if self.run and not self.run.done else None,
            "results": list(self.results),
            "warmup_s": WARMUP_S,
            "measure_s": MEASURE_S,
        }


__all__ = ["BenchRun", "PerfMonitor", "asdict", "clean_report"]
