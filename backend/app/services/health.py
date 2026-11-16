"""Server health under load: is the event loop keeping up, how far behind are events, CPU and
memory of this process — and a simple load level the rest of the app uses to shed work that
nobody would miss (reading ordinary chat aloud, every single like) before anything important.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
import time
from collections import deque
from typing import Any

# load levels
OK, BUSY, OVERLOADED = "ok", "busy", "overloaded"


def rss_mb() -> float | None:
    """Resident memory of this process in MB (Windows, Linux, macOS) — None if unknown."""
    try:
        import psutil  # type: ignore[import-not-found]

        return round(psutil.Process().memory_info().rss / 1048576, 1)
    except Exception:  # noqa: BLE001
        pass
    try:
        if sys.platform.startswith("linux"):
            with open("/proc/self/statm") as f:
                pages = int(f.read().split()[1])
            return round(pages * os.sysconf("SC_PAGE_SIZE") / 1048576, 1)
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            h = ctypes.windll.kernel32.GetCurrentProcess()  # type: ignore[attr-defined]
            if ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):  # type: ignore[attr-defined]
                return round(pmc.WorkingSetSize / 1048576, 1)
        if sys.platform == "darwin":
            import resource

            return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576, 1)
    except Exception:  # noqa: BLE001
        return None
    return None


def _p95(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, int(len(s) * 0.95))]


class ServerHealth:
    """Samples every `interval` seconds. Cheap: one timer, a few deques."""

    def __init__(self, bus=None, interval: float = 0.25, clock=time.monotonic):
        self.bus = bus
        self.interval = interval
        self.clock = clock
        self.loop_lag_ms: deque[float] = deque(maxlen=240)  # last minute
        self.event_lag_ms: deque[tuple[float, float]] = deque(maxlen=4000)  # (at, lag)
        self.handled: deque[float] = deque(maxlen=20000)
        self.cpu_pct: float | None = None
        self.rss_mb: float | None = None
        self.peak_bus_depth = 0
        self.level = OK
        self.level_since = clock()
        self.shed = 0  # pieces of optional work skipped because of load
        self._task: asyncio.Task | None = None
        self._cpu_mark = (time.process_time(), time.perf_counter())

    # ------------------------------------------------------------------ recording
    def event_handled(self, received_monotonic: float | None) -> None:
        now = self.clock()
        self.handled.append(now)
        if received_monotonic:
            self.event_lag_ms.append((now, max(0.0, (now - received_monotonic) * 1000.0)))

    def skip(self) -> None:
        self.shed += 1

    @property
    def busy(self) -> bool:
        return self.level != OK

    @property
    def overloaded(self) -> bool:
        return self.level == OVERLOADED

    # ------------------------------------------------------------------ sampling
    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="health")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        n = 0
        while True:
            t0 = time.perf_counter()
            await asyncio.sleep(self.interval)
            self.loop_lag_ms.append(max(0.0, (time.perf_counter() - t0 - self.interval) * 1000.0))
            n += 1
            if n % 4 == 0:  # once a second
                self.sample()

    def sample(self) -> None:
        cpu, wall = time.process_time(), time.perf_counter()
        c0, w0 = self._cpu_mark
        if wall - w0 > 0.2:
            self.cpu_pct = round(100.0 * (cpu - c0) / (wall - w0), 1)
            self._cpu_mark = (cpu, wall)
        self.rss_mb = rss_mb()
        depth = self.bus.depth if self.bus is not None else 0
        self.peak_bus_depth = max(self.peak_bus_depth, depth)
        self._update_level(depth)

    def _recent_lag(self, seconds: float = 5.0) -> float | None:
        now = self.clock()
        return _p95([lag for at, lag in self.event_lag_ms if now - at <= seconds])

    def _update_level(self, depth: int) -> None:
        cap = getattr(getattr(self.bus, "queue", None), "maxsize", 0) or 2000
        lag = self._recent_lag() or 0.0
        loop = max(list(self.loop_lag_ms)[-8:], default=0.0)
        if depth > cap * 0.5 or lag > 3000 or loop > 500:
            level = OVERLOADED
        elif depth > cap * 0.1 or lag > 800 or loop > 150:
            level = BUSY
        else:
            level = OK
        # leave a degraded level only after things stayed calm for 5 s (no flapping)
        now = self.clock()
        if level != self.level:
            worse = [OK, BUSY, OVERLOADED].index(level) > [OK, BUSY, OVERLOADED].index(self.level)
            if worse or now - self.level_since > 5.0:
                self.level = level
                self.level_since = now
        elif level != OK:
            self.level_since = now

    def rate(self, seconds: float = 5.0) -> float:
        now = self.clock()
        return round(sum(1 for t in self.handled if now - t <= seconds) / seconds, 1)

    def view(self) -> dict[str, Any]:
        loop = list(self.loop_lag_ms)
        return {
            "level": self.level,
            "events_per_s": self.rate(),
            "event_lag_ms_p95": round(self._recent_lag() or 0.0, 1),
            "loop_lag_ms_p95": round(_p95(loop) or 0.0, 1),
            "loop_lag_ms_max": round(max(loop, default=0.0), 1),
            "bus_depth": self.bus.depth if self.bus is not None else 0,
            "peak_bus_depth": self.peak_bus_depth,
            "dropped_low_priority": getattr(self.bus, "dropped_low_priority", 0),
            "cpu_pct": self.cpu_pct,
            "rss_mb": self.rss_mb,
            "shed": self.shed,
        }


class TokenBucket:
    """At most `rate` per second on average, `burst` at once."""

    def __init__(self, rate: float, burst: float, clock=time.monotonic):
        self.rate, self.burst, self.clock = rate, burst, clock
        self.tokens = burst
        self.at = clock()

    def allow(self) -> bool:
        now = self.clock()
        self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False
