"""“Sắp diễn ra”: next poem, next level-up, stage line, the shop's schedule — soonest first."""

from __future__ import annotations

import datetime as dt
import time

from app.services.upcoming import agenda_due


def _wait(pred, timeout=6.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def test_agenda_times():
    now = dt.datetime(2026, 11, 16, 21, 40)
    assert agenda_due("22:10", now) == dt.datetime(2026, 11, 16, 22, 10)
    assert agenda_due("21:00", now) is None  # over
    assert agenda_due("00:30", now) == dt.datetime(2026, 11, 17, 0, 30)  # tonight, after midnight
    assert agenda_due("09:00", dt.datetime(2026, 11, 16, 8, 0)) == dt.datetime(2026, 11, 16, 9, 0)
    assert agenda_due("25:00", now) is None


def test_schedule_is_checked(admin_client):
    c = admin_client
    cur = c.get("/api/v1/settings/scene").json()["config"]
    r = c.put("/api/v1/settings/scene", json={**cur, "agenda": [{"time": "22:10", "text": "  Mini-game   đoán giá "}]})
    assert r.status_code == 200 and r.json()["config"]["agenda"] == [{"time": "22:10", "text": "Mini-game đoán giá"}]
    assert c.put("/api/v1/settings/scene", json={**cur, "agenda": [{"time": "7:5", "text": "x"}]}).status_code == 422
    # a row left empty in the editor is dropped, the rest is sorted by time
    r = c.put("/api/v1/settings/scene", json={**cur, "agenda": [{"time": "23:00", "text": "B"}, {"time": "08:00", "text": " "}, {"time": "21:00", "text": "A"}]})
    assert r.status_code == 200 and [a["text"] for a in r.json()["config"]["agenda"]] == ["A", "B"]


def test_rows_soonest_first_and_pushed_to_the_game(admin_client):
    from .test_pipeline import game_ws, recv_until

    c = admin_client
    cont = c.app.state.container
    vn = dt.timezone(dt.timedelta(hours=7))  # schedules are in Vietnam time, whatever the server's clock
    soon = (dt.datetime.now(vn) + dt.timedelta(minutes=20)).strftime("%H:%M")
    later = (dt.datetime.now(vn) + dt.timedelta(minutes=50)).strftime("%H:%M")
    far = (dt.datetime.now(vn) + dt.timedelta(minutes=150)).strftime("%H:%M")
    cur = c.get("/api/v1/settings/scene").json()["config"]
    c.put("/api/v1/settings/scene", json={**cur, "agenda": [
        {"time": later, "text": "Giảm giá giờ vàng"}, {"time": soon, "text": "Mini-game đoán giá"},
        {"time": far, "text": "Quá xa, chưa hiện"}]})
    with game_ws(c) as ws:
        snap = ws.receive_json()
        assert "upcoming" in snap
        c.post("/api/v1/demo/start")
        # the owner's next poem (scheduled when the voice is on during a LIVE)
        cont.talk.next_in = lambda: 240.0
        msg, _ = recv_until(ws, lambda m: m["type"] == "UPCOMING" and any(r["kind"] == "poem" for r in m["upcoming"]["rows"]),
                            limit=2000)
    rows = msg["upcoming"]["rows"]
    kinds = [r["kind"] for r in rows]
    assert kinds[0] == "poem" and "agenda" in kinds  # 4 minutes first; (the next mini-game, 15–20 min, may come before the 20-min line)
    assert "game" in kinds
    assert rows == sorted(rows, key=lambda r: r["due"])
    assert "stage" not in [r["kind"] for r in rows]  # the stage has its own box
    texts = [r["text"] for r in rows]
    assert "Mini-game đoán giá" in texts and "Giảm giá giờ vàng" in texts and "Quá xa, chưa hiện" not in texts
    poem = next(r for r in rows if r["kind"] == "poem")
    assert abs(poem["due"] / 1000 - (time.time() + 240)) < 10
    assert any("nhảy" in t for t in msg["upcoming"]["tips"])


def test_next_level_up_shows(admin_client):
    from app.events.schema import EventUser

    c = admin_client
    cont = c.app.state.container
    c.post("/api/v1/demo/start")
    c.post("/api/v1/demo/events", json={"raw": "@Lan: chào shop"})
    assert _wait(lambda: any(a.nickname == "Lan" and a.visible for a in cont.avatars._by_key.values()))
    av = next(a for a in cont.avatars._by_key.values() if a.nickname == "Lan")
    k = av.viewer_key
    user = EventUser(platform_user_id=k[4:], nickname="Lan") if k.startswith("pid:") else EventUser(unique_id=k[4:], nickname="Lan")
    cont.levels.seen(user)
    cont.levels.watchers[k].watch_s = 4 * 60 + 10  # 50 s before the nón lá
    rows = cont.upcoming.rows()
    lvl = next(r for r in rows if r["kind"] == "level")
    assert lvl["text"] == "Lan sắp đội nón lá" and lvl["item"] == "nón lá"
    assert 30 <= lvl["due"] / 1000 - time.time() <= 60
