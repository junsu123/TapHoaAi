"""End-to-end through the real app: demo comment → pipeline → /ws/game command → client
ACKs → COMPLETED. The browser-side animation is verified separately by Playwright."""

import time



def recv_until(ws, predicate, limit=200):
    seen = []
    for _ in range(limit):
        msg = ws.receive_json()
        seen.append(msg)
        if predicate(msg):
            return msg, seen
    raise AssertionError(f"message not received; got {[m.get('type') for m in seen]}")


def game_ws(client, role="primary"):
    token = client.app.state.container.game_token
    return client.websocket_connect(f"/ws/game?role={role}&token={token}")


def test_game_ws_requires_token_off_loopback(app_client):
    import pytest
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with app_client.websocket_connect("/ws/game?role=primary") as ws:
            ws.receive_json()


def test_t03_comment_to_completed_action(admin_client):
    c = admin_client
    with game_ws(c) as ws:
        snap = ws.receive_json()
        assert snap["type"] == "SNAPSHOT" and len(snap["layout"]["shelves"]) == 6
        r = c.post("/api/v1/demo/events", json={"raw": "@lananh88: trà cà gai leo"})
        assert r.status_code == 200, r.text
        spawn, _ = recv_until(ws, lambda m: m.get("type") == "AVATAR_SPAWN")
        assert spawn["avatar"]["nickname"] == "lananh88" and spawn["avatar"]["is_demo"]
        action, _ = recv_until(ws, lambda m: m.get("type") == "CHARACTER_ACTION")
        assert action["product_id"] == "TRA_CA_GAI_LEO" and action["shelf_id"] == "KE_02"
        assert action["avatar_id"] == spawn["avatar"]["avatar_id"]
        assert isinstance(action["sequence"], int) and action["sequence"] > snap["sequence"]
        for t in ("ACK", "ACTION_STARTED", "ACTION_COMPLETED"):
            ws.send_json({"type": t, "command_id": action["command_id"]})
        for _ in range(50):
            rows = c.get("/api/v1/actions").json()
            if rows and rows[0]["status"] == "COMPLETED":
                break
            time.sleep(0.02)
        assert rows[0]["status"] == "COMPLETED" and rows[0]["product_id"] == "TRA_CA_GAI_LEO"
        m = c.get("/api/v1/metrics").json()
        assert m["actions"]["completed"] == 1 and m["actions"]["latency"]["samples"] == 1


def test_t05_ambiguous_comment_goes_to_host_not_game(admin_client):
    c = admin_client
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@lananh88: trà"})
        for _ in range(50):
            items = c.get("/api/v1/ai/suggestions").json()["items"]
            if items:
                break
            time.sleep(0.02)
        assert items[0]["intent"] == "AMBIGUOUS" and items[0]["status"] == "Chưa được trả lời"
        assert "cụ thể" in items[0]["hint"]
        ws.send_json({"type": "PING"})
        _, seen = recv_until(ws, lambda m: m.get("type") == "PONG")
        assert not [m for m in seen if m.get("type") == "CHARACTER_ACTION"]
    assert c.get("/api/v1/actions").json() == []


def test_t10_comment_without_join_creates_avatar_and_viewer_only_needs_command(admin_client):
    c = admin_client
    c.post("/api/v1/demo/events", json={"raw": "@khachmoi: chào shop"})
    for _ in range(50):
        if c.get("/api/v1/metrics").json()["avatars"]["total"] == 1:
            break
        time.sleep(0.02)
    assert c.get("/api/v1/metrics").json()["avatars"]["total"] == 1


def test_t18_reload_gets_snapshot_without_duplicates(admin_client):
    c = admin_client
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@lananh88: trà cà gai leo"})
        action, _ = recv_until(ws, lambda m: m.get("type") == "CHARACTER_ACTION")
        ws.send_json({"type": "ACK", "command_id": action["command_id"]})
    c.post("/api/v1/demo/events", json={"raw": "@lananh88: alo"})  # same user again
    with game_ws(c) as ws2:  # "reloaded" browser
        snap = ws2.receive_json()
        assert snap["type"] == "SNAPSHOT"
        assert [a["nickname"] for a in snap["avatars"]] == ["lananh88"]
        assert [x["command_id"] for x in snap["active_commands"]] == [action["command_id"]]
        assert snap["is_demo"] is True


def test_viewer_cannot_ack(admin_client):
    c = admin_client
    with game_ws(c) as primary, game_ws(c, role="viewer") as viewer:
        primary.receive_json()
        viewer.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@a1: trà ba kích"})
        action, _ = recv_until(viewer, lambda m: m.get("type") == "CHARACTER_ACTION")
        viewer.send_json({"type": "ACTION_COMPLETED", "command_id": action["command_id"]})
        viewer.send_json({"type": "PING"})
        recv_until(viewer, lambda m: m.get("type") == "PONG")
        assert c.get("/api/v1/actions").json()[0]["status"] == "DISPATCHED"


def test_replayed_events_are_deduplicated(admin_client):
    """T09/NFR-04: the same provider event id after a reconnect does not act twice."""
    c = admin_client
    for _ in range(3):
        c.post("/api/v1/demo/events", json={"raw": "@lananh88: trà cà gai leo", "event_id": "dup_1"})
    time.sleep(0.2)
    m = c.get("/api/v1/metrics").json()
    assert m["events"].get("COMMENT") == 1 and m["bus"]["duplicates_dropped"] == 2


def test_load_60_avatars_100_comments(admin_client):
    """T17 (backend part): bounded queues, no crash. FPS/RAM are measured in Playwright."""
    c = admin_client
    with game_ws(c) as ws:
        ws.receive_json()
        for i in range(100):
            text = ["trà cà gai leo", "trà ba kích", "trà", "chào shop"][i % 4]
            assert c.post("/api/v1/demo/events", json={"raw": f"@khach{i % 60:02d}: {text}"}).status_code == 200
        for _ in range(100):
            m = c.get("/api/v1/metrics").json()
            if m["events"].get("COMMENT") == 100:
                break
            time.sleep(0.05)
    assert m["events"]["COMMENT"] == 100
    assert m["avatars"]["total"] == 60 and m["avatars"]["visible"] == 60
    assert m["actions"]["queue_depth"] <= 60 * 3  # ≤ 1 active + 2 pending per viewer
    assert m["errors"] == 0
