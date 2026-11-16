"""High-viewership load test (stability): starts a fresh server, connects an OBS game page, a
preview page and two dashboards (one on a slow laptop), then simulates a busy LIVE at several
event rates and reports how the server copes.

    backend/.venv/bin/python scripts/loadtest.py --rates 100,300,600 --seconds 20 --out result.json

Everything runs locally in Demo mode; no TikTok, Claude or Vbee calls (fake AI).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / "backend" / ".venv" / "bin" / "python"
if not PY.exists():
    PY = Path(sys.executable)


def p95(xs):
    if not xs:
        return None
    s = sorted(xs)
    return round(s[min(len(s) - 1, int(len(s) * 0.95))], 1)


class WsClient:
    def __init__(self, name: str, url: str, headers: dict | None = None, slow: float = 0.0, primary: bool = False):
        self.name, self.url, self.headers, self.slow, self.primary = name, url, headers or {}, slow, primary
        self.msgs = 0
        self.frames = 0
        self.bytes = 0
        self.disconnects = 0
        self.comment_lag_ms: list[float] = []
        self.action_lag_ms: list[float] = []
        self.types: dict[str, int] = {}
        self.ws = None
        self._task = None
        self.stop = False

    def start(self):
        self._task = asyncio.create_task(self._run())

    async def _run(self):
        while not self.stop:
            try:
                async with websockets.connect(self.url, additional_headers=self.headers, max_size=None,
                                              open_timeout=10) as ws:
                    self.ws = ws
                    async for raw in ws:
                        self.frames += 1
                        self.bytes += len(raw)
                        data = json.loads(raw)
                        batch = data["messages"] if data.get("type") == "BATCH" else [data]
                        for m in batch:
                            await self._on(ws, m)
                        if self.slow:
                            await asyncio.sleep(self.slow)
                        if self.stop:
                            return
            except Exception:  # noqa: BLE001
                if self.stop:
                    return
                self.disconnects += 1
                await asyncio.sleep(0.5)

    async def _on(self, ws, m):
        self.msgs += 1
        t = m.get("type", "?")
        self.types[t] = self.types.get(t, 0) + 1
        if t == "COMMENT":
            at = m["comment"].get("at")
            if at:
                lag = (time.time() - datetime.fromisoformat(at).timestamp()) * 1000
                self.comment_lag_ms.append(lag)
        if not self.primary:
            return
        if t == "CHARACTER_ACTION":
            cid = m["command_id"]
            await ws.send(json.dumps({"type": "ACK", "command_id": cid}))
            await ws.send(json.dumps({"type": "ACTION_STARTED", "command_id": cid}))

            async def done():
                await asyncio.sleep(4)
                try:
                    await ws.send(json.dumps({"type": "ACTION_COMPLETED", "command_id": cid}))
                except Exception:  # noqa: BLE001
                    pass

            asyncio.create_task(done())
        elif t == "SPEECH":
            cid = m["clip"]["id"]
            await ws.send(json.dumps({"type": "SPEECH_STARTED", "id": cid}))

            async def end():
                await asyncio.sleep(2)
                try:
                    await ws.send(json.dumps({"type": "SPEECH_ENDED", "id": cid}))
                except Exception:  # noqa: BLE001
                    pass

            asyncio.create_task(end())

    def reset(self):
        self.msgs = self.frames = self.bytes = 0
        self.comment_lag_ms = []
        self.types = {}

    def view(self, seconds: float):
        return {"msgs_per_s": round(self.msgs / seconds, 1), "frames_per_s": round(self.frames / seconds, 1),
                "kb_per_s": round(self.bytes / 1024 / seconds, 1), "disconnects": self.disconnects,
                "comment_lag_ms_p50": round(statistics.median(self.comment_lag_ms), 1) if self.comment_lag_ms else None,
                "comment_lag_ms_p95": p95(self.comment_lag_ms), "comments_seen": len(self.comment_lag_ms),
                "types": dict(sorted(self.types.items(), key=lambda kv: -kv[1])[:8])}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rates", default="100,300,600")
    ap.add_argument("--seconds", type=int, default=20)
    ap.add_argument("--viewers", type=int, default=3000)
    ap.add_argument("--out", default=None)
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    port = free_port()
    data = Path(tempfile.mkdtemp()) / "data"
    env = {**os.environ, "CHIBI_DATA_DIR": str(data), "CHIBI_FAKE_AI": "1", "CHIBI_PORT": str(port)}
    subprocess.run([str(PY), str(ROOT / "scripts" / "seed_demo.py"), "--admin", "chu_shop", "--password",
                    "mat-khau-demo-123"], env=env, check=True, capture_output=True)
    log = open(data.parent / "server.log", "w")
    server = subprocess.Popen([str(PY), "-m", "app", "--host", "127.0.0.1", "--port", str(port)],
                              cwd=ROOT / "backend", env=env, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    try:
        async with httpx.AsyncClient(base_url=base, timeout=30) as http:
            for _ in range(100):
                try:
                    await http.get("/api/v1/auth/setup")
                    break
                except httpx.HTTPError:
                    await asyncio.sleep(0.2)
            r = await http.post("/api/v1/auth/login", json={"username": "chu_shop", "password": "mat-khau-demo-123"})
            r.raise_for_status()
            H = {"X-CSRF-Token": r.json()["csrf_token"]}
            cookie = "; ".join(f"{k}={v}" for k, v in http.cookies.items())
            # a realistic setup: voice on, greetings and comments read aloud, auto answers
            ai = (await http.get("/api/v1/settings/ai")).json()["config"]
            ai.update(voice_enabled=True, voice_policy_confirmed=True, greet_joins=True, read_comments=True,
                      read_questions=True, autopilot=True)
            await http.put("/api/v1/settings/ai", json={"config": ai}, headers=H)
            await http.post("/api/v1/demo/start", headers=H)
            token = (await http.get("/api/v1/game/info")).json()["remote_token"]
            ws_base = f"ws://127.0.0.1:{port}"
            clients = [
                WsClient("game_obs", f"{ws_base}/ws/game?role=primary&token={token}", primary=True),
                WsClient("game_preview", f"{ws_base}/ws/game?role=viewer&token={token}"),
                WsClient("dashboard", f"{ws_base}/ws/dashboard", {"Cookie": cookie, "Origin": base}),
                WsClient("dashboard_slow", f"{ws_base}/ws/dashboard", {"Cookie": cookie, "Origin": base}, slow=0.05),
            ]
            for c in clients:
                c.start()
            await asyncio.sleep(2)
            results = []
            for rate in [int(x) for x in args.rates.split(",")]:
                for c in clients:
                    c.reset()
                r = await http.post("/api/v1/game/loadtest", json={"rate": rate, "seconds": args.seconds,
                                                                     "viewers": args.viewers}, headers=H)
                r.raise_for_status()
                samples, api_ms = [], []
                t0 = time.monotonic()
                while time.monotonic() - t0 < args.seconds + 1:
                    a = time.perf_counter()
                    h = (await http.get("/api/v1/system/health")).json()
                    api_ms.append((time.perf_counter() - a) * 1000)
                    samples.append(h)
                    await asyncio.sleep(1.0)
                # how long until the backlog is gone
                drain = 0.0
                while drain < 60:
                    h = (await http.get("/api/v1/system/health")).json()
                    if h["server"]["bus_depth"] == 0:
                        break
                    await asyncio.sleep(0.5)
                    drain += 0.5
                el = time.monotonic() - t0
                srv = [s["server"] for s in samples]
                lt = samples[-1]["loadtest"] or {}
                res = {
                    "rate": rate, "achieved_rate": lt.get("achieved_rate"), "generator_behind_s": lt.get("behind_max_s"),
                    "handled_per_s_max": max(s["events_per_s"] for s in srv),
                    "event_lag_ms_p95_max": max(s["event_lag_ms_p95"] for s in srv),
                    "loop_lag_ms_max": max(s["loop_lag_ms_max"] for s in srv),
                    "bus_depth_max": max(s["bus_depth"] for s in srv),
                    "dropped_low_priority": srv[-1]["dropped_low_priority"],
                    "cpu_pct_avg": round(statistics.mean([s["cpu_pct"] for s in srv if s["cpu_pct"] is not None] or [0]), 1),
                    "cpu_pct_max": max((s["cpu_pct"] or 0) for s in srv),
                    "rss_mb_max": max((s["rss_mb"] or 0) for s in srv),
                    "api_ms_p95": p95(api_ms), "api_ms_max": round(max(api_ms), 1),
                    "backlog_drain_s": drain,
                    "avatars_visible": samples[-1]["avatars"]["visible"],
                    "level_max": max((s["level"] for s in srv), key=["ok", "busy", "overloaded"].index),
                    "shed": srv[-1].get("shed"),
                    "rss_mb_series": [s["rss_mb"] for s in srv][::10],
                    "clients": {c.name: c.view(el) for c in clients},
                }
                results.append(res)
                print(json.dumps(res, ensure_ascii=False), flush=True)
                await asyncio.sleep(5)
            # still responsive afterwards?
            a = time.perf_counter()
            (await http.get("/api/v1/metrics")).raise_for_status()
            after_ms = round((time.perf_counter() - a) * 1000, 1)
            for c in clients:
                c.stop = True
            out = {"label": args.label, "results": results, "metrics_after_ms": after_ms,
                   "server_alive": server.poll() is None}
            print(json.dumps({"metrics_after_ms": after_ms, "server_alive": out["server_alive"]}))
            if args.out:
                Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2))
    finally:
        server.terminate()
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    asyncio.run(main())
