"""Khách quen (viewers across LIVEs) and the dance stage's "sắp tới lượt bạn"."""

from __future__ import annotations

import json
import time

from app.services.regulars import STATE_KEY


def _wait(pred, timeout=6.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def _new_live(c, gap_s: float = 3600):
    """End the LIVE and start another one `gap_s` later (> 20 minutes: a new LIVE)."""
    cont = c.app.state.container
    c.post("/api/v1/live/disconnect")
    st = json.loads(cont.get_setting(STATE_KEY) or "{}")
    if "demo" in st:
        st["demo"]["alive"] -= gap_s
        cont.set_setting(STATE_KEY, json.dumps(st), secret=False)
    c.post("/api/v1/demo/start")


def _avatar(cont, name):
    assert _wait(lambda: any(a.nickname == name for a in cont.avatars._by_key.values()))
    return next(a for a in cont.avatars._by_key.values() if a.nickname == name)


def test_a_viewer_who_comes_back_is_welcomed_back_by_name(admin_client):
    c = admin_client
    cont = c.app.state.container
    cfg = c.get("/api/v1/settings/ai").json()["config"]
    cfg.update(voice_enabled=True, voice_policy_confirmed=True, greet_joins=True, poem_auto=False)
    c.put("/api/v1/settings/ai", json={"config": cfg})
    c.post("/api/v1/voice/unmute")
    said: list[str] = []
    real = cont.assistant.announce
    cont.assistant.announce = lambda kind, text: said.append(text) or real(kind, text)

    c.post("/api/v1/demo/start")
    first_seq = cont.regulars.seq
    c.post("/api/v1/demo/events", json={"raw": "@Thu: chào shop"})
    assert _wait(lambda: cont.regulars.stats["new"] >= 1)
    thu = _avatar(cont, "Thu")
    assert cont.regulars.visits_of(thu.viewer_key) == 1

    # the next LIVE (an hour later): Thu comes back
    _new_live(c)
    assert cont.regulars.seq == first_seq + 1
    c.post("/api/v1/demo/events", json={"raw": "@Thu: chào shop nha"})
    assert _wait(lambda: cont.regulars.stats["returning"] == 1)
    assert _wait(lambda: any("Thu quay lại rồi! Buổi LIVE thứ 2 liên tiếp" in t for t in said), timeout=8)
    # … in place of the usual "Chào bạn Thu …"
    assert not any(k == thu.viewer_key for _, k, _ in cont.assistant._welcome_pending)
    v = c.get("/api/v1/regulars").json()
    assert v["returning"] == 1 and v["top"][0]["name"] == "Thu" and v["top"][0]["streak"] == 2
    assert v["recent_back"][0]["name"] == "Thu"

    # a LIVE missed: the streak starts again, but the visits keep counting → khách quen (3 LIVEs)
    _new_live(c)
    _new_live(c)
    c.post("/api/v1/demo/events", json={"raw": "@Thu: lại là mình đây"})
    assert _wait(lambda: cont.regulars.stats["returning"] == 1)
    p = cont.regulars.here[thu.viewer_key]
    assert p["visits"] == 3 and p["streak"] == 1
    av = _avatar(cont, "Thu")
    assert _wait(lambda: av.to_dict()["visits"] == 3)


def test_a_restart_in_the_middle_of_a_live_keeps_minutes_and_level(admin_client):
    c = admin_client
    cont = c.app.state.container
    c.post("/api/v1/demo/start")
    seq = cont.regulars.seq
    c.post("/api/v1/demo/events", json={"raw": "@Lan: chào shop"})
    lan = _avatar(cont, "Lan")
    assert _wait(lambda: lan.viewer_key in cont.regulars.here)
    cont.levels.watchers[lan.viewer_key].watch_s = 6 * 60  # 6 minutes: nón lá
    cont.levels.watchers[lan.viewer_key].level = 1
    # the server goes down and comes back a few minutes later: the same LIVE
    _new_live(c, gap_s=0)
    assert cont.regulars.seq == seq
    cont.writer.flush_sync()
    c.post("/api/v1/demo/events", json={"raw": "@Lan: mình vẫn ở đây"})
    assert _wait(lambda: cont.regulars.stats["continued"] == 1)
    assert cont.levels.level_of(lan.viewer_key) == 1
    assert cont.levels.watchers[lan.viewer_key].watch_s >= 6 * 60
    assert cont.regulars.stats["returning"] == 0  # not "welcome back": it is the same LIVE


def test_stage_calls_the_next_dancers_and_shows_the_wait(admin_client):
    c = admin_client
    cont = c.app.state.container
    said: list[str] = []
    cont.assistant.announce = lambda kind, text: said.append(text) or True
    c.post("/api/v1/demo/start")
    for n in ("an", "binh", "chi", "dung"):
        c.post("/api/v1/demo/events", json={"raw": f"@{n}: nhảy"})
    assert _wait(lambda: cont.stage.current is not None and len(cont.stage.queue) == 3)
    st = cont.stage
    assert _wait(lambda: st.soon_calls, timeout=4)
    # binh and chi have two (or fewer) dancers before them: called by name, together; dung not yet
    assert st.soon_calls[0]["names"] == ["binh", "chi"]
    assert any("binh và chi ơi, sắp tới lượt các bạn" in t for t in said)
    q = st.view()["queue"]
    assert [x["name"] for x in q] == ["binh", "chi", "dung"]
    etas = [x["eta_s"] for x in q]
    assert etas == sorted(etas) and etas[1] - etas[0] >= st.seconds  # one turn apart
