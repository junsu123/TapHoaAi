"""Nhật ký lỗi: every warning/error while running, secrets masked, kept across restarts."""

from __future__ import annotations

import logging

from app.services.error_log import ErrorLog, area_of, redact

from .test_pipeline import recv_until


def test_redacts_secrets():
    s = redact("key sk-ant-api03-AbCdEf123456 Authorization: Bearer eyJhbGciOi.abcdefgh.ijklmnop token=abc12345 "
               "app_id: 8f1e-6e8d-xyz password=hunter22")
    assert "AbCdEf123456" not in s and "abcdefgh" not in s and "abc12345" not in s and "hunter22" not in s
    assert "8f1e-6e8d" not in s and "sk-ant-•••" in s


def test_dedupes_persists_and_rotates(tmp_path):
    log = ErrorLog(tmp_path)
    a = log.add("ERROR", "chibi.ai", "Claude: key sai")
    b = log.add("ERROR", "chibi.ai", "Claude: key sai")
    assert a is b and a.count == 2 and len(log.records) == 1
    log.add("WARNING", "chibi.tiktok", "Mất kết nối")
    again = ErrorLog(tmp_path)  # after a restart
    assert [r.message for r in again.records] == ["Claude: key sai", "Mất kết nối"]
    assert again.records[0].count == 2 and again.add("ERROR", "x", "new").id == 3
    assert area_of("chibi.ai") == "Trợ lý AI (Claude)" and area_of("chibi.client.game") == "Trang game (OBS)"
    assert area_of("TikTokLive.client") == "TikTok LIVE" and area_of("random.lib") == "Thư viện ngoài"
    import app.services.error_log as el
    old = el.FILE_MAX_BYTES
    el.FILE_MAX_BYTES = 200
    try:
        for i in range(30):
            log.add("ERROR", "chibi", f"lỗi số {i} " + "x" * 50)
    finally:
        el.FILE_MAX_BYTES = old
    assert (tmp_path / "errors.jsonl.1").exists() and not (tmp_path / "errors.jsonl.6").exists()


def test_logged_errors_reach_the_page_and_the_dashboard_live(admin_client):
    c = admin_client
    with c.websocket_connect("/ws/dashboard") as ws:
        ws.receive_json()  # snapshot
        logging.getLogger("chibi.ai").warning("Claude: key sk-ant-api03-SECRET999999 không hợp lệ",
                                              extra={"ctx": {"model": "claude-haiku-5-5"}})
        msg, _ = recv_until(ws, lambda m: m.get("type") == "LOG")
        assert msg["record"]["area"] == "Trợ lý AI (Claude)" and "SECRET999999" not in msg["record"]["message"]
    r = c.get("/api/v1/logs").json()
    item = next(i for i in r["items"] if i["message"].startswith("Claude: key"))
    assert item["level"] == "WARNING" and item["context"]["model"] == "claude-haiku-5-5"
    assert r["stats"]["unseen"] >= 1 and "Trợ lý AI (Claude)" in r["areas"]
    # info is not an error
    logging.getLogger("chibi.ai").info("chỉ là thông tin")
    assert not any("chỉ là thông tin" in i["message"] for i in c.get("/api/v1/logs").json()["items"])
    c.post("/api/v1/logs/seen", json={"id": r["stats"]["last_id"]})
    assert c.get("/api/v1/logs").json()["stats"]["unseen"] == 0
    txt = c.get("/api/v1/logs/export.txt")
    assert txt.status_code == 200 and "Claude: key" in txt.text and "attachment" in txt.headers["content-disposition"]
    c.post("/api/v1/logs/clear")
    assert c.get("/api/v1/logs").json()["items"] == []


def test_unexpected_endpoint_error_is_logged_with_a_vietnamese_500(admin_client):
    c = admin_client

    def boom():
        raise ZeroDivisionError("chia cho 0")

    c.app.add_api_route("/api/v1/_boom", boom)
    r = c.get("/api/v1/_boom")
    assert r.status_code == 500 and "Nhật ký lỗi" in r.json()["error"]["message"]
    item = c.get("/api/v1/logs?level=ERROR").json()["items"][0]
    assert item["area"] == "API" and item["context"]["path"] == "/api/v1/_boom"
    assert "ZeroDivisionError" in item["detail"] and f"#{item['id']}" in r.json()["error"]["message"]


def test_background_task_errors_are_logged(admin_client):
    c = admin_client
    cont = c.app.state.container
    try:
        raise RuntimeError("tác vụ hỏng")
    except RuntimeError as exc:
        cont._loop_exception(None, {"message": "Task exception was never retrieved", "exception": exc})
    item = c.get("/api/v1/logs?level=ERROR").json()["items"][0]
    assert item["area"] == "Tác vụ nền" and "tác vụ hỏng" in item["detail"]


def test_browser_errors_are_accepted_from_admin_or_this_computer(admin_client):
    app_client = admin_client
    body = {"page": "game", "kind": "webgl", "message": "WebGL context lost", "stack": "at render (World.tsx:10)",
            "url": "http://127.0.0.1:8686/game/live", "user_agent": "OBS"}
    from fastapi.testclient import TestClient

    remote = TestClient(app_client.app, client=("203.0.113.5", 50000))
    assert remote.post("/api/v1/logs/client", json=body).status_code == 403  # another PC, not signed in
    assert app_client.post("/api/v1/logs/client", json=body).status_code == 204  # this PC (OBS), no login
    assert admin_client.post("/api/v1/logs/client", json=body).status_code == 204
    item = admin_client.get("/api/v1/logs").json()["items"][0]
    assert item["count"] == 2  # same error twice: one line, ×2
    assert item["area"] == "Trang game (OBS)" and item["message"] == "Lỗi đồ họa 3D (WebGL): WebGL context lost"
    assert item["detail"] == "at render (World.tsx:10)"


def test_repeated_reconnects_are_one_line(tmp_path):
    log = ErrorLog(tmp_path)
    for attempt in range(1, 6):
        log.add("WARNING", "chibi.live", "Mất kết nối TikTok LIVE: ProxyError", None, {"lần thử gần nhất": attempt})
    assert len(log.records) == 1 and log.records[0].count == 5
    assert log.records[0].context["lần thử gần nhất"] == "5"
