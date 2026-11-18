"""Banned words: the host teaches them from a comment; such comments are never read nor answered,
the owner gently reminds the viewer, and someone who keeps doing it is muted for the LIVE.
And the owner learns how to answer a comment from the host."""

from __future__ import annotations

import time

from app.services.text_safety import find_banned

from .test_pipeline import game_ws, recv_until
from .test_stage_talk import _until, _voice_on


def test_find_banned_names_the_word():
    assert find_banned("shop bán đồ dỏm quá", ["đồ dỏm"]) == "đồ dỏm"
    assert find_banned("SHOP BÁN DO DOM", ["đồ dỏm"]) == "đồ dỏm"  # without diacritics, upper case
    assert find_banned("đ.m shop", []) == "dm"  # built-in list
    assert find_banned("trà ngon quá", ["đồ dỏm"]) is None
    assert find_banned("đồ dỏmxyz", ["đồ dỏm"]) is None  # whole words only


def test_a_banned_comment_is_not_read_the_owner_reminds_and_mutes_after_three(admin_client):
    c = admin_client
    cont = c.app.state.container
    _voice_on(c)
    said: list[tuple[str, str]] = []
    real = cont.assistant.announce
    cont.assistant.announce = lambda kind, text: said.append((kind, text)) or real(kind, text)
    c.post("/api/v1/demo/start")
    # the host teaches a word picked from a comment
    v = c.post("/api/v1/moderation/words", json={"word": "đồ dỏm"}).json()
    assert v["words"] == ["đồ dỏm"] and v["action"] == "remind" and v["mute_after"] == 3
    assert c.post("/api/v1/moderation/words", json={"word": "ĐỒ DỎM"}).json()["words"] == ["đồ dỏm"]  # no duplicate
    assert c.post("/api/v1/moderation/words", json={"word": "!"}).status_code == 422

    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@tuan: shop bán do dom à"})
        # not read: the only line is the owner's reminder (by name, without the word)
        sp, _ = recv_until(ws, lambda m: m.get("type") == "SPEECH", limit=500)
        assert sp["clip"]["kind"] == "remind" and "tuan" in sp["clip"]["text"] and "dom" not in sp["clip"]["text"].lower()
    m = c.get("/api/v1/moderation").json()
    assert m["recent"][0]["word"] == "đồ dỏm" and m["recent"][0]["reminded"] and m["blocked_total"] == 1
    assert not any(i.get("nickname") == "tuan" for i in cont.assistant.items.values())  # not answered either
    rec = next(r for r in cont.orchestrator.recent_comments if r.get("nickname") == "tuan")
    assert "đồ dỏm" in rec["blocked"]

    # once every 5 minutes for the same viewer; the third time they are muted for this LIVE
    for _ in range(2):
        c.post("/api/v1/demo/events", json={"raw": "@tuan: đồ dỏm"})
    _until(lambda: c.get("/api/v1/moderation").json()["blocked_total"] == 3)
    assert [k for k, _ in said].count("remind") == 1
    m = c.get("/api/v1/moderation").json()
    assert [x["name"] for x in m["muted"]] == ["tuan"]
    # muted: even a clean comment is not read
    c.post("/api/v1/demo/events", json={"raw": "@tuan: trà ngon"})
    _until(lambda: c.get("/api/v1/moderation").json()["recent"][0]["text"] == "trà ngon")
    assert c.get("/api/v1/moderation").json()["recent"][0]["muted"]
    # the host lifts it
    key = m["muted"][0]["key"]
    assert c.post("/api/v1/moderation/unmute", json={"key": key}).json()["muted"] == []

    # "skip": nothing is said at all
    m = c.put("/api/v1/moderation", json={"action": "skip", "remind_template": "Bạn {ten} ơi, nhẹ nhàng nha!", "mute_after": 0}).json()
    assert m["action"] == "skip"
    said.clear()
    cont.moderation._last_remind = -1e9
    c.post("/api/v1/demo/events", json={"raw": "@lan: đồ dỏm"})
    _until(lambda: c.get("/api/v1/moderation").json()["recent"][0]["name"] == "lan")
    time.sleep(0.3)
    assert not any(k == "remind" for k, _ in said)
    assert c.put("/api/v1/moderation", json={"action": "remind", "remind_template": "Bạn {ai} ơi", "mute_after": 3}).status_code == 422

    # a new LIVE: strikes and mutes start over, the list stays
    c.post("/api/v1/live/disconnect")
    c.post("/api/v1/demo/start")
    m = c.get("/api/v1/moderation").json()
    assert m["muted"] == [] and m["words"] == ["đồ dỏm"]
    assert c.request("DELETE", "/api/v1/moderation/words", params={"word": "Đồ Dỏm"}).json()["words"] == []


def test_a_banned_comment_is_no_game_answer_nor_errand(admin_client):
    c = admin_client
    cont = c.app.state.container
    c.post("/api/v1/moderation/words", json={"word": "lừa đảo"})
    c.post("/api/v1/demo/events", json={"raw": "@ky: trà cà gai leo lừa đảo"})
    _until(lambda: any(r.get("nickname") == "ky" for r in cont.orchestrator.recent_comments))
    rec = next(r for r in cont.orchestrator.recent_comments if r.get("nickname") == "ky")
    assert rec["action_outcome"] == "blocked" and rec["command_id"] is None


def test_the_owner_learns_a_reply_to_a_comment(admin_client):
    """The host teaches the owner how to answer a comment; the next similar comment gets it."""
    c = admin_client
    cont = c.app.state.container
    _voice_on(c)
    r = c.post("/api/v1/knowledge", json={"questions": ["shop ơi mấy giờ live tiếp"],
                                          "answer": "Dạ tối nào shop cũng live lúc 8 giờ ạ!"})
    assert r.status_code == 201
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@mai: mấy giờ live tiếp vậy shop"})
        ans, _ = recv_until(ws, lambda m: m.get("type") == "SPEECH" and m["clip"]["kind"] == "answer", limit=800)
        assert "8 giờ" in ans["clip"]["text"]
    item = next(i for i in cont.assistant.items.values() if i.get("nickname") == "mai")
    assert item["draft_source"] == "memory"


def test_the_ai_settings_form_does_not_drop_a_taught_word(admin_client):
    c = admin_client
    cfg = c.get("/api/v1/settings/ai").json()["config"]  # the form, loaded before
    c.post("/api/v1/moderation/words", json={"word": "hàng fake"})
    c.put("/api/v1/settings/ai", json={"config": {**cfg, "shop_name": "Mộc Tâm"}})
    assert c.get("/api/v1/moderation").json()["words"] == ["hàng fake"]
