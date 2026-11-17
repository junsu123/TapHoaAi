"""Mini-games: price guess, quiz, keyword race — answers, winners, medals, the board, the schedule."""

from __future__ import annotations

import random
import time

from app.services.minigames import MiniGames, parse_choice, parse_price

from .test_pipeline import game_ws, recv_until


class Wall:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


def _games(cont, seed=1) -> tuple[MiniGames, Wall]:
    """Mini-games on a hand-driven clock (the container's ticker then drives this one too)."""
    w = Wall()
    g = MiniGames(cont, clock=w, rng=random.Random(seed))
    cont.games = g
    cont.avatars.medals_of = g.medals_of
    return g, w


def _say(c, raw):
    c.post("/api/v1/demo/events", json={"raw": raw})


def _wait(pred, timeout=6.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.03)
    return False


def test_parsing_answers():
    assert parse_price("85") == 85_000
    assert parse_price("85k") == 85_000
    assert parse_price("85.000") == 85_000
    assert parse_price("85,000đ") == 85_000
    assert parse_price("tầm 92 nghìn") == 92_000
    assert parse_price("120000") == 120_000
    assert parse_price("1tr2") == 1_200_000
    assert parse_price("đẹp quá") is None
    assert parse_choice("A") == 0 and parse_choice("b") == 1 and parse_choice("đáp án C") == 2
    assert parse_choice("chọn a!") == 0
    assert parse_choice("anh ơi") is None and parse_choice("D") is None


def test_price_guess_closest_wins(admin_client):
    c = admin_client
    cont = c.app.state.container
    c.post("/api/v1/demo/start")
    g, w = _games(cont)
    assert g._priced(), "the demo catalog has checked prices"
    r = g.start("price", manual=True)
    price = r.data["price"]
    w.t += 6
    g.tick()
    assert r.phase == "open"
    _say(c, f"@xa: {price // 1000 + 40}")
    _say(c, f"@gan: {price // 1000 - 2}k")
    _say(c, f"@xa: {price // 1000}")  # a second answer does not count
    _say(c, "@khach: shop ơi trà này uống lúc nào")  # not an answer: goes on as usual
    assert _wait(lambda: len(r.answers) == 2)
    rec = [x for x in cont.orchestrator.recent_comments if x["nickname"] in ("xa", "gan")]
    assert {x["action_outcome"] for x in rec} == {"game_answer", "game_again"}
    assert not [h for h in cont.orchestrator.host_attention if h["nickname"] in ("xa", "gan")]  # never to the host / Claude
    w.t += cont.scene.minigame_seconds + 1
    g.tick()
    assert r.phase == "reveal" and [x["name"] for x in r.winners] == ["gan"]
    v = g.view()
    assert v["price"] == price and v["closest"][0]["name"] == "gan"
    board = cont.board.view()
    assert board["games"][0] == {"name": "gan", "wins": 1}
    w.t += 11
    g.tick()
    assert g.round is None and g.history[-1]["winners"] == ["gan"]
    assert g.next_at is not None  # the next one scheduled


def test_quiz_first_three_right_answers_win_and_get_a_medal(admin_client):
    c = admin_client
    cont = c.app.state.container
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/start")
        g, w = _games(cont, seed=3)
        r = g.start("quiz", manual=True)
        right = "ABC"[r.data["answer"]]
        wrong = "ABC"[(r.data["answer"] + 1) % 3]
        state, _ = recv_until(ws, lambda m: m["type"] == "GAME_STATE" and m["game"] and m["game"]["kind"] == "quiz")
        assert "answer" not in state["game"] and len(state["game"]["options"]) == 3  # never the answer before the reveal
        for n in ("an", "binh", "chi", "dung"):
            _say(c, f"@{n}: {right if n != 'binh' else wrong}")
            time.sleep(0.05)
        assert _wait(lambda: len(r.answers) == 4)
        w.t += 5 + cont.scene.minigame_seconds + 1
        g.tick()  # intro → open
        g.tick()  # open → reveal
        assert r.phase == "reveal"
        assert [x["name"] for x in r.winners] == ["an", "chi", "dung"] and r.data["right"] == 3
        medal, _ = recv_until(ws, lambda m: m["type"] == "AVATAR_MEDAL")
        assert medal["medals"] == 1
        say, _ = recv_until(ws, lambda m: m["type"] == "OWNER_SAY" and m.get("kind") == "game" and "Đáp án đúng" in m["text"])
        assert f"Đáp án đúng là {right}" in say["text"]
    an = next(a for a in cont.avatars._by_key.values() if a.nickname == "an")
    assert an.medals == 1 and an.to_dict()["medals"] == 1


def test_keyword_race_ends_with_three(admin_client):
    c = admin_client
    cont = c.app.state.container
    c.post("/api/v1/demo/start")
    g, w = _games(cont, seed=5)
    r = g.start("keyword", manual=True)
    kw = r.data["keyword"]
    for n in ("a1", "a2", "a3", "a4"):
        _say(c, f"@{n}: {kw.lower()}!!")
        time.sleep(0.05)
    assert _wait(lambda: len(r.answers) >= 3)
    w.t += 6
    g.tick()
    g.tick()
    assert r.phase == "reveal" and len(r.winners) == 3 and "Chúc mừng" in g._reveal_text(r)


def test_schedule_every_15_to_20_minutes_and_settings(admin_client):
    c = admin_client
    cont = c.app.state.container
    g, w = _games(cont)
    g.tick()
    assert g.next_at is None  # no LIVE: nothing scheduled
    c.post("/api/v1/demo/start")
    g.tick()
    assert 15 * 60 <= g.next_in() <= 20 * 60
    w.t += g.next_in() + 1
    g.tick()
    assert g.round is not None and not g.round.manual
    first = g.round.kind
    g.stop()
    w.t = g.next_at + 1
    g.tick()
    assert g.round.kind != first  # not the same kind twice in a row
    v = c.get("/api/v1/games").json()
    assert v["enabled"] and set(v["kinds"]) <= {"price", "quiz", "keyword"}
    cur = c.get("/api/v1/settings/scene").json()["config"]
    ok = c.put("/api/v1/settings/scene", json={**cur, "minigame_questions": [
        {"question": "Shop mình tên là gì?", "options": ["Tiệm trà thảo mộc", "Tiệm bánh", "Tiệm hoa"]}]})
    assert ok.status_code == 200
    # an unfinished row in the editor is dropped; two identical answers are a mistake to fix
    half = c.put("/api/v1/settings/scene", json={**cur, "minigame_questions": [{"question": "Hỏi gì?", "options": ["A", "B", ""]}]})
    assert half.status_code == 200 and half.json()["config"]["minigame_questions"] == []
    bad = c.put("/api/v1/settings/scene", json={**cur, "minigame_questions": [{"question": "Hỏi gì?", "options": ["A", "a", "B"]}]})
    assert bad.status_code == 422


def test_api_start_stop(admin_client):
    c = admin_client
    assert c.post("/api/v1/games/start", json={"kind": "quiz"}).status_code == 409  # no LIVE
    c.post("/api/v1/demo/start")
    r = c.post("/api/v1/games/start", json={"kind": "keyword"})
    assert r.status_code == 200 and r.json()["kind"] == "keyword"
    assert c.post("/api/v1/games/start", json={"kind": "quiz"}).status_code == 409  # one at a time
    assert c.get("/api/v1/games").json()["round"]["kind"] == "keyword"
    assert c.post("/api/v1/games/stop").json()["ok"] is True
    assert c.get("/api/v1/games").json()["round"] is None
