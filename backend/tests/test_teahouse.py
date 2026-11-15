"""Shop-owner Chibi lines (greeting bubbles, tea for gift givers, thanks for buyers) and the honour board."""

from __future__ import annotations

from .test_pipeline import game_ws, recv_until


def join(c, uid, nick=None):
    c.post("/api/v1/demo/events", json={"type": "JOIN", "unique_id": uid, "nickname": nick or uid})


def start_demo(c):
    r = c.post("/api/v1/demo/start")
    assert r.status_code in (200, 409), r.text


def test_joins_become_owner_greeting_bubbles_without_repeats(admin_client):
    c = admin_client
    start_demo(c)
    with game_ws(c) as ws:
        ws.receive_json()
        for n in ("Lan", "Minh", "Hoa", "Tú"):
            join(c, n.lower(), n)
        join(c, "lan", "Lan")  # already greeted
        m, _ = recv_until(ws, lambda m: m.get("type") == "OWNER_GREET")
        assert m["text"] == "Xin chào quý khách Lan, Minh và Hoa đã vào quán!"
        m2, _ = recv_until(ws, lambda m: m.get("type") == "OWNER_GREET")
        assert m2["text"] == "Xin chào quý khách Tú đã vào quán!"
    hist = [h["text"] for h in c.app.state.container.owner.history if h["type"] == "OWNER_GREET"]
    assert sum("Lan" in t for t in hist) == 1


def test_a_crowd_is_greeted_together(admin_client):
    c = admin_client
    owner = c.app.state.container.owner
    for i in range(12):
        owner.on_join(f"Khách {i}", f"uid:k{i}")
    m = owner.flush(now=10_000.0)
    assert m and m["more"] == 9
    assert m["text"] == "Xin chào quý khách Khách 0, Khách 1, Khách 2 và 9 bạn khác đã vào quán!"
    assert owner.flush(now=10_001.0) is None  # nothing left, and bubbles never overlap


def test_gift_invites_to_tea_and_lands_on_the_honour_board(admin_client):
    c = admin_client
    start_demo(c)
    with game_ws(c) as ws:
        ws.receive_json()
        r = c.post("/api/v1/demo/events", json={"type": "GIFT", "unique_id": "lananh88", "nickname": "Lan Anh",
                                                "gift_name": "Hoa hồng", "diamonds": 1, "repeat_count": 5,
                                                "repeat_end": True, "streakable": True})
        assert r.status_code == 200, r.text
        m, seen = recv_until(ws, lambda m: m.get("type") == "OWNER_TEA")
        assert m["avatar_id"] and m["name"] == "Lan Anh"
        assert m["text"] == "Mời Lan Anh dùng trà ạ! Cảm ơn Lan Anh đã tặng 5 Hoa hồng!"
        assert any(x.get("type") == "LEADERBOARD" for x in seen)
    top = c.get("/api/v1/leaderboard").json()["gifts"][0]
    assert top == {"name": "Lan Anh", "gifts": 5, "coins": 5}


def test_host_records_purchases_owner_thanks_and_board_ranks(admin_client):
    c = admin_client
    cont = c.app.state.container
    pid = "TRA_CA_GAI_LEO"
    price = cont.catalog.products[pid].display_price
    with game_ws(c) as ws:
        ws.receive_json()
        r = c.post("/api/v1/leaderboard/purchase", json={"name": "Minh Tú", "product_id": pid, "qty": 2})
        assert r.status_code == 200, r.text
        m, _ = recv_until(ws, lambda m: m.get("type") == "OWNER_THANKS")
        assert m["text"] == f"Cảm ơn Minh Tú đã mua 2 {cont.catalog.products[pid].name} ạ!"
    c.post("/api/v1/leaderboard/purchase", json={"name": "Hoa", "product_name": "Trà gừng", "qty": 1, "amount": 500000,
                                                 "thank": False})
    board = c.get("/api/v1/leaderboard").json()
    assert [b["name"] for b in board["buyers"]][:2] == ["Hoa", "Minh Tú"]
    assert board["buyers"][1]["amount"] == (price or 0) * 2 and board["buyers"][1]["items"] == 2
    pid0 = board["recent_purchases"][0]["id"]
    assert c.delete(f"/api/v1/leaderboard/purchase/{pid0}").status_code == 200
    assert [b["name"] for b in c.get("/api/v1/leaderboard").json()["buyers"]] == ["Minh Tú"]
    assert c.post("/api/v1/leaderboard/purchase", json={"name": "X"}).status_code == 422
    assert c.post("/api/v1/leaderboard/purchase", json={"name": "X", "product_id": "nope"}).status_code == 404
    assert c.post("/api/v1/leaderboard/reset").json()["buyers"] == []


def test_each_live_starts_a_fresh_board(admin_client):
    c = admin_client
    board = c.app.state.container.board
    board.add_gift("uid:a", "A", 1, 10, "session-1", False)
    assert board.view()["gifts"][0]["coins"] == 10
    board.add_gift("uid:b", "B", 1, 1, "session-2", False)
    assert [g["name"] for g in board.view()["gifts"]] == ["B"]
