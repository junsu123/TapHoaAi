"""Chibi behaviour spec V3, P1 — performance reports, benchmark (T16), on-screen cap
(SUSPEND_LOD) and behaviour settings."""

from __future__ import annotations

import time

from app.services.perf import MEASURE_S, WARMUP_S, PerfMonitor, clean_report

from .test_pipeline import game_ws, recv_until

REPORT = {"fps": 31.5, "frame_ms_p95": 40.2, "sim_ms": 0.42, "render_calls": 812, "triangles": 260000,
          "heap_mb": 88.1, "gpu": "NVIDIA GeForce GTX 1650", "quality": "medium", "avatars": 30,
          "lod": {"full": 4, "reduced": 10, "far": 14, "hidden": 2}}


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_reports_are_cleaned():
    r = clean_report({"fps": "fast", "frame_ms_p95": -3, "avatars": 1e12, "gpu": "x" * 500, "lod": "nope"})
    assert r["fps"] is None and r["frame_ms_p95"] == 0 and r["avatars"] == 10_000
    assert len(r["gpu"]) == 120 and r["lod"] == {"full": 0, "reduced": 0, "far": 0, "hidden": 0}


def test_benchmark_skips_warmup_and_summarises():
    clock = Clock()
    m = PerfMonitor(clock=clock)
    m.start(30)
    m.add({**REPORT, "fps": 5})  # warm-up (shop still filling up): ignored
    for i in range(5):
        clock.t = WARMUP_S + i * 4
        m.add({**REPORT, "fps": 30 + i, "heap_mb": 80 + i})
    assert m.view()["running"]["samples"] == 5
    clock.t = WARMUP_S + MEASURE_S + 0.1
    m.add(REPORT)
    res = m.view()["results"][-1]
    assert res["done"] and res["target"] == 30 and res["samples"] == 6
    assert res["fps_min"] == 30 and res["heap_mb"] == 88.1
    assert res["gpu"] == "NVIDIA GeForce GTX 1650"
    assert m.view()["running"] is None


def test_perf_report_reaches_dashboard(admin_client):
    c = admin_client
    with game_ws(c) as ws:
        ws.receive_json()
        ws.send_json({"type": "PERF_REPORT", **REPORT})
        ws.send_json({"type": "PING"})
        recv_until(ws, lambda m: m.get("type") == "PONG")
    v = c.get("/api/v1/game/perf").json()
    assert v["last"]["fps"] == 31.5 and v["last"]["lod"]["far"] == 14
    assert c.get("/api/v1/metrics").json()["game_perf"]["render_calls"] == 812


def test_viewer_page_cannot_report(admin_client):
    c = admin_client
    with game_ws(c, role="viewer") as ws:
        ws.receive_json()
        ws.send_json({"type": "PERF_REPORT", **REPORT})
        time.sleep(0.1)
    assert c.get("/api/v1/game/perf").json()["last"] is None


def test_benchmark_fills_the_shop_and_clears_it(admin_client):
    c = admin_client
    assert c.post("/api/v1/game/benchmark", json={"count": 30}).status_code == 409  # no game page open
    with game_ws(c) as ws:
        ws.receive_json()
        r = c.post("/api/v1/game/benchmark", json={"count": 30})
        assert r.status_code == 200, r.text
        assert r.json()["target"] == 30
        deadline = time.time() + 5
        while time.time() < deadline and c.get("/api/v1/game/perf").json()["visible"] < 30:
            time.sleep(0.05)
        v = c.get("/api/v1/game/perf").json()
        assert v["visible"] == 30 and v["running"] is not None
        # asking again for 30 adds nobody
        assert c.post("/api/v1/game/benchmark", json={"count": 30}).json()["added"] == 0
        out = c.post("/api/v1/game/benchmark/clear").json()
        assert out["left"] == 30
        recv_until(ws, lambda m: m.get("type") == "AVATAR_EXIT" and m.get("reason") == "benchmark_clear")
    assert c.get("/api/v1/game/perf").json()["visible"] == 0
    assert c.post("/api/v1/game/benchmark", json={"count": 500}).status_code == 422


def test_on_screen_cap_keeps_extra_viewers_waiting(admin_client):
    """SUSPEND_LOD: over the cap, newcomers wait off screen (nobody invented) and come in when
    someone leaves."""
    c = admin_client
    cont = c.app.state.container
    base = c.get("/api/v1/settings/scene").json()["config"]
    r = c.put("/api/v1/settings/scene", json={**base, "chibi_max_visible": 10})
    assert r.status_code == 200 and cont.avatars.max_visible == 10
    with game_ws(c) as ws:
        ws.receive_json()
        for i in range(10):
            c.post("/api/v1/demo/events", json={"raw": f"@kh{i}: trà cà gai leo"})
        deadline = time.time() + 5
        while time.time() < deadline and len(cont.avatars.visible()) < 10:
            time.sleep(0.05)
        c.post("/api/v1/demo/events", json={"raw": "@nguoi11: trà ba kích"})
        time.sleep(0.3)
        assert len(cont.avatars.visible()) == 10  # everyone busy with a box: the 11th waits
        assert len(cont.avatars.overflow) == 1
    assert c.put("/api/v1/settings/scene", json={**base, "chibi_max_visible": 5}).status_code == 422
    c.put("/api/v1/settings/scene", json=base)


def test_behaviour_settings_are_saved_and_sent_to_the_game(admin_client):
    c = admin_client
    base = c.get("/api/v1/settings/scene").json()["config"]
    assert base["chibi_w_browse"] == 30 and base["chibi_w_fun"] == 5 and base["chibi_autonomous"] is True
    with game_ws(c) as ws:
        ws.receive_json()
        r = c.put("/api/v1/settings/scene", json={**base, "chibi_w_fun": 0, "chibi_autonomous": False})
        assert r.status_code == 200
        msg, _ = recv_until(ws, lambda m: m.get("type") == "SCENE_UPDATED")
        assert msg["scene"]["chibi_w_fun"] == 0 and msg["scene"]["chibi_autonomous"] is False
    assert c.put("/api/v1/settings/scene", json={**base, "chibi_w_rest": 101}).status_code == 422
    c.put("/api/v1/settings/scene", json=base)
