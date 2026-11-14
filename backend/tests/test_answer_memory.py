"""Conversation log + answer memory: confirmed answers are reused without calling Claude."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

from app.models import ConversationTurn
from app.services.answer_memory import AnswerMemory

from .test_ai_voice import CFG, ScriptedClaude, next_speech, play, setup, wait_item
from .test_pipeline import game_ws

MEM = {**CFG, "simple_auto": True, "simple_auto_speak": True, "learn_enabled": True}


def usage_reply(text="Dạ bạn pha 1 gói với 200 ml nước sôi, đợi 5 phút là uống được ạ.", review=False):
    return {"intent": "USAGE", "product_id": "TRA_CA_GAI_LEO", "confidence": 0.9, "suggested_reply": text,
            "needs_human_review": review}


def tea(c):
    return c.app.state.container.catalog.products["TRA_CA_GAI_LEO"]


def vnd(v):
    return f"{v:,}".replace(",", ".") + " đồng"


def test_host_confirmed_answer_is_reused_for_similar_questions_without_claude(admin_client):
    c = admin_client
    claude = ScriptedClaude(usage_reply())
    cont = setup(c, claude, **{k: v for k, v in MEM.items() if k not in CFG or k.startswith(("simple", "learn"))})
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@mai: shop ơi trà cà gai leo uống thế nào ạ?"})
        play(ws, next_speech(ws))  # the question
        first = wait_item(c, lambda i: i["status"] == "AI đề xuất")
        assert len(claude.calls) == 1
        r = c.post(f"/api/v1/ai/suggestions/{first['event_id']}/speak", json={})
        assert r.json()["spoken"]
        play(ws, next_speech(ws))  # the answer
        for _ in range(100):
            if c.get("/api/v1/knowledge").json()["items"]:
                break
            time.sleep(0.03)
        learned = c.get("/api/v1/knowledge").json()["items"]
        assert len(learned) == 1 and learned[0]["trusted"] and learned[0]["source"] == "host"

        # another viewer, other words, same meaning: answered at once, no Claude call
        c.post("/api/v1/demo/events", json={"raw": "@tuan: cà gai leo uống ntn vậy shop"})
        play(ws, next_speech(ws))  # question
        a = next_speech(ws)
        assert a["kind"] == "answer" and a["text"].startswith("Dạ bạn pha 1 gói")
        play(ws, a)
        item = wait_item(c, lambda i: i["nickname"] == "tuan" and i["status"] == "Đã trả lời tự động")
        assert item["suggestion_label"].startswith("Câu đã học") and item["draft_source"] == "memory"
        assert len(claude.calls) == 1

    # every question of the session is in the log, with who answered it
    log = c.get("/api/v1/conversations").json()["items"]
    by_nick = {t["nickname"]: t for t in log}
    assert by_nick["mai"]["answered_by"] == "host" and by_nick["mai"]["draft_source"] == "claude"
    assert by_nick["mai"]["cost_usd"] > 0 and by_nick["mai"]["spoken"]
    assert by_nick["tuan"]["answered_by"] == "memory" and by_nick["tuan"]["knowledge_id"] == learned[0]["id"]
    sessions = c.get("/api/v1/conversations/sessions").json()["sessions"]
    assert sessions[0]["questions"] >= 2 and sessions[0]["is_demo"]
    csv = c.get(f"/api/v1/conversations/export.csv?session_id={sessions[0]['session_id']}")
    assert csv.text.startswith("﻿Thời gian") and "uống ntn" in csv.text
    stats = c.get("/api/v1/conversations/stats").json()
    assert stats["answered_without_claude_24h"] >= 1 and stats["claude_calls_24h"] == 1
    assert cont.assistant.memory.entries[learned[0]["id"]].uses == 1


def test_price_questions_are_simple_and_learned_prices_follow_the_catalog(admin_client):
    c = admin_client
    claude = ScriptedClaude(usage_reply())
    setup(c, claude, simple_auto=True, learn_enabled=True, voice_enabled=False)
    c.post("/api/v1/demo/events", json={"raw": "@p1: trà cà gai leo giá bao nhiêu"})
    item = wait_item(c, lambda i: i["nickname"] == "p1" and i.get("suggestion"))
    assert claude.calls == [] and item["draft_source"] == "template" and vnd(tea(c).display_price) in item["suggestion"]

    # a confirmed answer that says today's price stores it as {gia}…
    price = tea(c).display_price
    kid = c.post("/api/v1/knowledge", json={"questions": ["combo 2 hộp trà cà gai leo bao nhiêu"],
                                             "product_id": "TRA_CA_GAI_LEO",
                                             "answer": f"Dạ mỗi hộp {vnd(price)}, mua 2 hộp shop tặng 1 gói dùng thử ạ."}
                 ).json()
    assert "{gia}" in kid["answer"]
    # …so after a price change the shop never says the old price
    q = {"question": "combo 2 hộp cà gai leo bao nhiêu vậy", "product_id": "TRA_CA_GAI_LEO"}
    c.patch("/api/v1/products/TRA_CA_GAI_LEO", json={"price": price + 10000})
    assert c.post("/api/v1/knowledge/test", json=q).json()["answer"] is None  # new price not confirmed yet
    c.patch("/api/v1/products/TRA_CA_GAI_LEO", json={"verify_price": True})
    t = c.post("/api/v1/knowledge/test", json=q).json()
    assert t["matched"] and vnd(price + 10000) in t["answer"] and vnd(price) not in t["answer"]


def test_auto_answers_wait_for_review_and_admin_can_edit_disable_delete(admin_client):
    c = admin_client
    claude = ScriptedClaude(usage_reply())
    setup(c, claude, simple_auto=True, learn_enabled=True, answer_mode="auto", read_questions=False)
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@a: trà cà gai leo uống thế nào"})
        play(ws, next_speech(ws))
        wait_item(c, lambda i: i["status"] == "Đã đọc tự động")
    for _ in range(100):
        pending = c.get("/api/v1/knowledge?status=pending").json()["items"]
        if pending:
            break
        time.sleep(0.03)
    assert pending and pending[0]["source"] == "auto" and not pending[0]["trusted"]
    # not trusted yet → the next similar question still goes to Claude
    c.post("/api/v1/demo/events", json={"raw": "@b: cà gai leo uống thế nào shop"})
    wait_item(c, lambda i: i["nickname"] == "b" and i.get("draft_source"))
    assert len(claude.calls) == 2

    kid = pending[0]["id"]
    r = c.patch(f"/api/v1/knowledge/{kid}", json={"answer": "Dạ pha 1 gói với nước sôi 5 phút ạ.",
                                                  "add_question": "pha trà cà gai leo sao"})
    assert r.json()["trusted"] and len(r.json()["variants"]) >= 2
    t = c.post("/api/v1/knowledge/test", json={"question": "trà cà gai leo pha sao vậy"}).json()
    assert t["matched"] and t["answer"] == "Dạ pha 1 gói với nước sôi 5 phút ạ."
    c.patch(f"/api/v1/knowledge/{kid}", json={"enabled": False})
    assert not c.post("/api/v1/knowledge/test", json={"question": "trà cà gai leo pha sao vậy"}).json()["matched"]
    assert c.delete(f"/api/v1/knowledge/{kid}").status_code == 204
    assert c.get("/api/v1/knowledge").json()["items"] == []


def test_memory_rules(catalog, db):
    mem = AnswerMemory(db)
    mem.load(catalog)
    kw = {"catalog": catalog, "threshold": 0.75}
    assert mem.learn("trà cà gai leo còn hàng không", "TRA_CA_GAI_LEO", "STOCK", "Dạ còn ạ", trusted=True,
                     source="host", **kw) is None  # stock changes: never learned
    kid = mem.learn("hôm nay có khuyến mãi không", None, "OTHER", "Dạ hôm nay giảm 10% ạ", trusted=True,
                    source="host", **kw)
    assert kid and not mem.entries[kid].trusted  # time-sensitive: kept for review only
    kid2 = mem.learn("có ship cod không shop", None, "SHIPPING_PAYMENT", "Dạ shop có giao COD toàn quốc ạ",
                     trusted=True, source="host", **kw)
    assert mem.match("shop có giao cod ko", None, catalog, 0.75).answer == "Dạ shop có giao COD toàn quốc ạ"
    assert mem.match("ship hà nội mấy ngày", None, catalog, 0.75) is None
    # an unconfirmed wording never replaces a confirmed answer
    mem.learn("có ship cod không", None, "SHIPPING_PAYMENT", "Có nha", trusted=False, source="auto", **kw)
    assert mem.entries[kid2].answer == "Dạ shop có giao COD toàn quốc ạ"
    # a learned answer that would now promise a cure is never said
    kid3 = mem.add_manual(["trà này tốt cho gan không"], "TRA_CA_GAI_LEO", "Dạ trà chữa khỏi bệnh gan ạ", catalog)
    assert mem.render(mem.entries[kid3], catalog) is None


def test_retention_blanks_names_but_keeps_conversations(admin_client):
    c = admin_client
    cont = c.app.state.container
    c.post("/api/v1/demo/events", json={"raw": "@cu: shop có ship cod không"})
    wait_item(c, lambda i: i["nickname"] == "cu")
    cont.retention_once(now=datetime.now(UTC) + timedelta(days=30))
    with cont.db.session() as s:
        t = s.query(ConversationTurn).filter(ConversationTurn.question.like("%ship cod%")).one()
        assert t.nickname is None and t.question
