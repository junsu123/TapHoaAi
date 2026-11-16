"""Chibis level up with watch time (5 / 15 / 30 minutes): counting, presence, level-ups, reminders."""

from __future__ import annotations

import time

from app.events.schema import EventUser
from app.services.levels import LevelService

from .test_pipeline import game_ws, recv_until


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _levels(cont) -> tuple[LevelService, Clock]:
    """A LevelService on a hand-driven clock, driven by the test only (the container's own one keeps
    running on the real clock, harmlessly: nobody reaches a level in the few seconds of a test)."""
    clk = Clock()
    lv = LevelService(cont, clock=clk)
    cont.avatars.level_of = lv.level_of
    return lv, clk


def _avatar_named(cont, name, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        for av in list(cont.avatars._by_key.values()):
            if av.nickname == name:
                return av
        time.sleep(0.05)
    raise AssertionError(f"no Chibi for {name}")


def _user_of(av) -> EventUser:
    """The viewer behind a Chibi (same identity key)."""
    k = av.viewer_key
    if k.startswith("pid:"):
        return EventUser(platform_user_id=k[4:], nickname=av.nickname)
    return EventUser(unique_id=k[4:], nickname=av.nickname)


def _run(lv: LevelService, clk: Clock, seconds: float, step: float = 5.0, keep=()):
    """Let time pass; viewers in `keep` do something every minute (a like…)."""
    t = 0.0
    while t < seconds:
        clk.t += step
        t += step
        if keep and int(t) % 60 == 0:
            for u in keep:
                lv.seen(u)
        lv.tick()


def test_minutes_count_while_the_viewer_is_around(admin_client):
    c = admin_client
    cont = c.app.state.container
    c.post("/api/v1/demo/start")
    lv, clk = _levels(cont)
    lan = EventUser(unique_id="lan", nickname="Lan")
    lv.seen(lan)
    lv.tick()
    _run(lv, clk, 4 * 60 + 50, keep=[lan])
    assert lv.level_of("uid:lan") == 0
    _run(lv, clk, 15, keep=[lan])
    assert lv.level_of("uid:lan") == 1  # 5 minutes: nón lá
    _run(lv, clk, 10 * 60, keep=[lan])
    assert lv.level_of("uid:lan") == 2  # 15: áo choàng
    _run(lv, clk, 15 * 60, keep=[lan])
    assert lv.level_of("uid:lan") == 3  # 30: vương miện
    v = lv.view()
    assert v["top"][0]["name"] == "Lan" and v["top"][0]["level"] == 3
    assert [u["item"] for u in reversed(v["recent"])] == ["nón lá", "áo choàng", "vương miện"]


def test_a_silent_viewer_stops_counting_after_the_presence_window(admin_client):
    c = admin_client
    cont = c.app.state.container
    c.post("/api/v1/demo/start")
    cont.scene = cont.scene.model_copy(update={"level_presence_min": 3})
    lv, clk = _levels(cont)
    lv.seen(EventUser(unique_id="im", nickname="Im"))
    lv.tick()
    _run(lv, clk, 20 * 60)  # never does anything again
    w = lv.watchers["uid:im"]
    assert 3 * 60 - 6 <= w.watch_s <= 3 * 60 + 6  # counted 3 minutes, then stopped
    assert w.level == 0 and "uid:im" not in lv.active
    # a like: the clock runs again, and the minutes already watched are kept
    lv.seen(EventUser(unique_id="im", nickname="Im"))
    _run(lv, clk, 2 * 60 + 10)
    assert lv.level_of("uid:im") == 1


def test_level_up_on_the_game_and_the_owner_congratulates(admin_client):
    c = admin_client
    cont = c.app.state.container
    cont.scene = cont.scene.model_copy(update={"level_minutes": [1, 2, 3], "owner_enabled": True})
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/start")
        c.post("/api/v1/demo/events", json={"raw": "@minh: chào shop"})
        spawn, _ = recv_until(ws, lambda m: m["type"] == "AVATAR_SPAWN" and m["avatar"]["nickname"] == "minh")
        assert spawn["avatar"]["level"] == 0
        lv, clk = _levels(cont)
        minh = _user_of(_avatar_named(cont, "minh"))
        lv.seen(minh)
        lv.tick()
        _run(lv, clk, 65, keep=[minh])
        up, _ = recv_until(ws, lambda m: m["type"] == "AVATAR_LEVEL")
        assert up == {**up, "avatar_id": spawn["avatar"]["avatar_id"], "level": 1, "up": True, "item": "nón lá"}
        say, _ = recv_until(ws, lambda m: m["type"] == "OWNER_SAY" and m.get("kind") == "level")
        assert "minh" in say["text"] and "nón lá" in say["text"]
        # progress bars: towards level 2
        aid = spawn["avatar"]["avatar_id"]
        prog, _ = recv_until(ws, lambda m: m["type"] == "LEVEL_PROGRESS" and any(r[0] == aid and r[1] == 1 for r in m["items"]))
        row = next(r for r in prog["items"] if r[0] == aid)
        assert 0 <= row[2] <= 1
    # a Chibi that comes in later wears its level straight away
    assert cont.avatars.find(minh).to_dict()["level"] == 1
    assert lv.level_of(minh.identity_key) == 1


def test_owner_reminds_a_minute_before_the_next_level(admin_client):
    c = admin_client
    cont = c.app.state.container
    cfg = c.get("/api/v1/settings/ai").json()["config"]
    cfg.update(voice_enabled=True, voice_policy_confirmed=True, poem_auto=False)
    c.put("/api/v1/settings/ai", json={"config": cfg})
    c.post("/api/v1/voice/unmute")
    c.post("/api/v1/demo/start")
    c.post("/api/v1/demo/events", json={"raw": "@Hoa: chào shop"})
    hoa = _user_of(_avatar_named(cont, "Hoa"))
    lv, clk = _levels(cont)
    said: list[tuple[str, str]] = []
    cont.assistant.announce = lambda kind, text: said.append((kind, text)) or True
    cont.speech.pending = lambda: 0
    lv.seen(hoa)
    lv.tick()
    _run(lv, clk, 4 * 60, keep=[hoa])  # 4 of 5 minutes
    rem = [t for k, t in said if "còn khoảng 1 phút" in t]
    assert len(rem) == 1 and rem[0].startswith("Hoa ơi") and "nón lá" in rem[0]
    _run(lv, clk, 70, keep=[hoa])
    assert any(t.startswith("Chúc mừng Hoa") for _, t in said)
    assert len([t for _, t in said if "còn khoảng 1 phút" in t]) == 1  # once per level


def test_level_minutes_are_checked(admin_client):
    c = admin_client
    cur = c.get("/api/v1/settings/scene").json()["config"]
    r = c.put("/api/v1/settings/scene", json={**cur, "level_minutes": [30, 5, 15]})
    assert r.json()["config"]["level_minutes"] == [5, 15, 30]
    r = c.put("/api/v1/settings/scene", json={**cur, "level_minutes": [5, 5]})
    assert r.json()["config"]["level_minutes"] == [5, 15, 30]
    assert c.get("/api/v1/levels").json()["minutes"] == [5, 15, 30]


def test_try_it_in_demo(admin_client):
    c = admin_client
    cont = c.app.state.container
    r = c.post("/api/v1/levels/try", json={})
    assert r.status_code == 409  # not in demo
    c.post("/api/v1/demo/start")
    c.post("/api/v1/demo/events", json={"raw": "@Thu: chào shop"})
    av = _avatar_named(cont, "Thu")
    deadline = time.time() + 5
    while not av.visible and time.time() < deadline:
        time.sleep(0.05)
    r = c.post("/api/v1/levels/try", json={"name": "Thu"})
    assert r.status_code == 200 and r.json()["next"] == "nón lá"
    deadline = time.time() + 5
    while cont.levels.level_of(av.viewer_key) < 1 and time.time() < deadline:
        time.sleep(0.05)
    assert cont.levels.level_of(av.viewer_key) == 1 and av.level == 1
