"""M4: Claude drafts answers to viewer questions, Vbee reads questions/answers on the LIVE."""

from __future__ import annotations

import json
import time

import httpx
import pytest

from app.services.claude_service import Completion, check_draft
from app.services.text_safety import sanitize_comment
from app.services.tts_vbee import FakeTts, TtsError, VbeeTts, split_text

from .test_pipeline import game_ws, recv_until

CFG = {"model": "claude-haiku-5-5", "budget_day_usd": 0.5, "budget_month_usd": 15, "max_output_tokens": 300,
       "shop_name": "Mộc Tâm", "shop_facts": "Ship toàn quốc, nhận hàng rồi thanh toán (COD).", "banned_words": ["lừa đảo"],
       "voice_enabled": True, "voice_policy_confirmed": True, "read_questions": True, "answer_mode": "approve",
       "voice_code": "hn_female_ngochuyen_full_48k-fhg", "voice_speed": 1.0, "voice_month_chars": 200000,
       "question_template": "Bạn {ten} hỏi: {cau_hoi}", "answer_prefix": ""}


class ScriptedClaude:
    def __init__(self, *replies: dict):
        self.replies = list(replies)
        self.calls: list[dict] = []

    async def complete(self, **kw) -> Completion:
        self.calls.append(kw)
        out = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return Completion(json.dumps(out, ensure_ascii=False), 1200, 80)


def safe_price_reply(price="120.000 đồng"):
    return {"intent": "PRICE", "product_id": "TRA_CA_GAI_LEO", "confidence": 0.95,
            "suggested_reply": f"Dạ trà cà gai leo giá {price} ạ, bạn bấm giỏ hàng để đặt nhé.",
            "needs_human_review": False}


def setup(c, claude: ScriptedClaude, **cfg):
    r = c.put("/api/v1/settings/ai", json={"config": {**CFG, **cfg}, "claude_api_key": "sk-ant-test-1234567890abcd",
                                            "vbee_app_id": "app-123", "vbee_token": "tok-456"})
    assert r.status_code == 200, r.text
    cont = c.app.state.container
    cont.assistant.client = claude
    cont.speech.provider = FakeTts()
    return cont


def price_of_tea(c) -> str:
    p = c.app.state.container.catalog.products["TRA_CA_GAI_LEO"]
    return f"{p.display_price:,}".replace(",", ".") + " đồng"


def wait_item(c, pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        items = c.get("/api/v1/ai/suggestions").json()["items"]
        for it in items:
            if pred(it):
                return it
        time.sleep(0.03)
    raise AssertionError(f"no matching item: {[(i['text'], i['status']) for i in items]}")


def next_speech(ws):
    msg, _ = recv_until(ws, lambda m: m.get("type") == "SPEECH")
    return msg["clip"]


def play(ws, clip):
    ws.send_json({"type": "SPEECH_STARTED", "id": clip["id"]})
    ws.send_json({"type": "SPEECH_ENDED", "id": clip["id"]})


# ---------------------------------------------------------------------------- settings
def test_settings_keep_secrets_server_side_and_require_policy(admin_client):
    c = admin_client
    r = c.put("/api/v1/settings/ai", json={"config": {**CFG, "voice_policy_confirmed": False}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "policy_not_confirmed"
    r = c.put("/api/v1/settings/ai", json={"config": CFG, "claude_api_key": "sk-ant-api03-SECRETSECRET-xyz9",
                                           "vbee_app_id": "8f1e6e8d-app", "vbee_token": "eyJhbGciOi.secret.token"})
    assert r.status_code == 200
    body = r.text + c.get("/api/v1/settings/ai").text
    assert "SECRETSECRET" not in body and "secret.token" not in body
    s = c.get("/api/v1/settings/ai").json()
    assert s["secrets"]["claude_api_key"].startswith("sk-ant") and "…" in s["secrets"]["claude_api_key"]
    assert s["status"]["configured"] and s["status"]["voice_ready"]
    # "" removes a secret, None keeps it
    c.put("/api/v1/settings/ai", json={"config": CFG, "claude_api_key": ""})
    s = c.get("/api/v1/settings/ai").json()
    assert s["secrets"]["claude_api_key"] is None and s["secrets"]["vbee_token"] is not None
    assert c.app.state.container.get_setting("vbee_token") == "eyJhbGciOi.secret.token"


# ---------------------------------------------------------------------------- the flow
def test_question_is_read_then_host_approves_the_answer(admin_client):
    c = admin_client
    claude = ScriptedClaude(safe_price_reply(price_of_tea(admin_client)))
    setup(c, claude)
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@lananh_1988: trà cà gai leo giá bao nhiêu? gọi 0912345678"})
        q = next_speech(ws)
        assert q["kind"] == "question" and q["label"] == "Câu hỏi của khách"
        assert q["text"] == "Bạn lananh hỏi: trà cà gai leo giá bao nhiêu? gọi"  # phone number never read
        audio = c.get(q["url"])
        assert audio.status_code == 200 and audio.content[:4] == b"RIFF"
        play(ws, q)

        item = wait_item(c, lambda i: i["status"] == "AI đề xuất")
        assert item["suggestion"].startswith("Dạ trà cà gai leo giá") and item["suggestion_label"] == "AI đề xuất"
        # the prompt holds the comment as data and never the viewer's name or phone number
        user = claude.calls[0]["user"]
        assert "<binh_luan>" in user and "lananh" not in user and "0912345678" not in user
        assert "Mộc Tâm" in claude.calls[0]["system"] and "COD" in user
        assert claude.calls[0]["model"] == "claude-haiku-5-5"
        assert claude.calls[0]["schema"]["properties"]["product_id"]["anyOf"][0]["enum"]

        r = c.post(f"/api/v1/ai/suggestions/{item['event_id']}/speak", json={"text": "Dạ trà cà gai leo giá " + price_of_tea(c) + " ạ."})
        assert r.status_code == 200 and r.json()["spoken"] is True
        a = next_speech(ws)
        assert a["kind"] == "answer" and a["label"] == "Trợ lý AI" and a["text"].startswith("Dạ trà cà gai leo")
        play(ws, a)
    item = wait_item(c, lambda i: i["event_id"] == item["event_id"])
    assert item["status"] == "Người trực đã xác nhận"
    status = c.get("/api/v1/settings/ai").json()["status"]
    assert status["budget"]["day_usd"] > 0 and status["budget"]["tts_chars_month"] > 0


def test_auto_mode_reads_safe_answers_but_holds_risky_ones(admin_client):
    c = admin_client
    risky = {"intent": "HEALTH", "product_id": "TRA_CA_GAI_LEO", "confidence": 0.9,
             "suggested_reply": "Dạ trà giúp chữa bệnh gan rất tốt ạ.", "needs_human_review": False}
    claude = ScriptedClaude(safe_price_reply(price_of_tea(admin_client)), risky)
    setup(c, claude, answer_mode="auto", read_questions=False)
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@khach1: trà cà gai leo giá bao nhiêu"})
        a = next_speech(ws)
        assert a["kind"] == "answer"
        play(ws, a)
        wait_item(c, lambda i: i["status"] == "Đã đọc tự động")
        c.post("/api/v1/demo/events", json={"raw": "@khach2: trà cà gai leo uống có hết bệnh gan không"})
        item = wait_item(c, lambda i: i["status"] == "Cần người trực xem")
        assert any("sức khỏe" in r for r in item["review_reasons"])
        time.sleep(0.3)
        assert c.app.state.container.speech.current is None and not c.app.state.container.speech.queue


def test_duplicates_share_one_claude_call(admin_client):
    c = admin_client
    claude = ScriptedClaude(safe_price_reply(price_of_tea(admin_client)))
    setup(c, claude, voice_enabled=False)
    c.post("/api/v1/demo/events", json={"raw": "@a1: trà cà gai leo giá bao nhiêu"})
    wait_item(c, lambda i: i["status"] == "AI đề xuất")
    c.post("/api/v1/demo/events", json={"raw": "@a2: Trà cà gai leo giá bao nhiêu"})
    dup = wait_item(c, lambda i: i["status"] == "Trùng câu hỏi")
    assert dup["suggestion"].startswith("Dạ trà cà gai leo") and len(claude.calls) == 1


def test_budget_exhausted_uses_catalog_template_without_calling_claude(admin_client):
    c = admin_client
    claude = ScriptedClaude(safe_price_reply())
    setup(c, claude, budget_day_usd=0.0000001, voice_enabled=False)
    c.post("/api/v1/demo/events", json={"raw": "@b1: trà cà gai leo giá bao nhiêu"})
    item = wait_item(c, lambda i: i.get("suggestion"))
    assert claude.calls == []
    assert item["suggestion_label"] == "Câu mẫu từ danh mục" and price_of_tea(c) in item["suggestion"]
    assert "hạn mức" in item["hint"]
    # the game still served the product (AI-05: no-AI mode keeps everything else running)
    assert any(a["product_id"] == "TRA_CA_GAI_LEO" for a in c.get("/api/v1/actions").json())


def test_no_key_keeps_host_flow(admin_client):
    c = admin_client
    c.post("/api/v1/demo/events", json={"raw": "@c1: shop có ship COD không"})
    item = wait_item(c, lambda i: "ship" in i["text"])
    assert item["status"] == "Chưa được trả lời" and item["suggestion"] is None


def test_kill_switch_hold_and_pause(admin_client):
    c = admin_client
    claude = ScriptedClaude(safe_price_reply(price_of_tea(admin_client)))
    cont = setup(c, claude)
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/voice/hold", json={"hold": True})
        recv_until(ws, lambda m: m.get("type") == "SPEECH_HOLD" and m["hold"] is True)
        c.post("/api/v1/demo/events", json={"raw": "@d1: trà cà gai leo giá bao nhiêu"})
        time.sleep(0.5)
        assert cont.speech.current is None and len(cont.speech.queue) == 1  # waits while the host talks
        c.post("/api/v1/voice/hold", json={"hold": False})
        q = next_speech(ws)
        ws.send_json({"type": "SPEECH_STARTED", "id": q["id"]})
        r = c.post("/api/v1/voice/kill").json()
        assert r["speech"]["muted"] and r["speech"]["current"] is None
        recv_until(ws, lambda m: m.get("type") == "SPEECH_STOP")
        c.post("/api/v1/demo/events", json={"raw": "@d2: shop có ship cod không"})
        time.sleep(0.3)
        assert not cont.speech.queue and c.get("/api/v1/voice/state").json()["ai"]["voice_reason"].startswith("Giọng đã bị tắt")
        c.post("/api/v1/voice/unmute")
        wait_item(c, lambda i: "ship" in i["text"] and i.get("suggestion"))  # muted voice, drafts still come
        calls = len(claude.calls)
        c.post("/api/v1/ai/pause", json={"paused": True})
        c.post("/api/v1/demo/events", json={"raw": "@d3: trà ba kích giá bao nhiêu"})
        time.sleep(0.3)
        assert not cont.speech.queue and len(claude.calls) == calls  # paused: no Claude, no voice
        c.post("/api/v1/ai/pause", json={"paused": False})


def test_voice_test_endpoint_and_locked_setting(admin_client):
    c = admin_client
    setup(c, ScriptedClaude(safe_price_reply()))
    cont = c.app.state.container
    cont.settings.fake_ai = True
    r = c.post("/api/v1/settings/voice/test", json={"text": "Xin chào"}).json()
    assert r["ok"] and c.get(r["url"]).status_code == 200
    cont.settings.tts_locked = True
    assert c.get("/api/v1/voice/state").json()["ai"]["voice_ready"] is False


# ---------------------------------------------------------------------------- units
def test_check_draft_guards(catalog):
    known = next(p for p in catalog.products.values() if p.display_price)
    good = {"intent": "PRICE", "product_id": known.id, "confidence": 0.9, "needs_human_review": False,
            "suggested_reply": f"Dạ giá {known.display_price:,}đ ạ".replace(",", ".")}
    assert check_draft(good, catalog).needs_review is False
    d = check_draft({**good, "product_id": "HACKED"}, catalog)
    assert d.product_id is None and d.needs_review
    d = check_draft({**good, "suggested_reply": "Dạ giá 9.000đ thôi ạ"}, catalog)
    assert d.needs_review and any("Giá không có" in r for r in d.review_reasons)
    d = check_draft({**good, "suggested_reply": "Uống trà này khỏi bệnh, không cần uống thuốc"}, catalog)
    assert d.needs_review
    assert check_draft({**good, "confidence": 0.3}, catalog).needs_review


def test_sanitize_comment():
    assert sanitize_comment("xem www.abc.vn nè", []) == "xem nè"
    assert sanitize_comment("shop đ.m giá bao nhiêu", []) is None  # built-in profanity, any spelling
    assert sanitize_comment("vcl đắt thế", []) is None
    assert sanitize_comment("trà này có làm lợi sữa không", []) == "trà này có làm lợi sữa không"
    assert sanitize_comment("đồ lừa đảo", ["lừa đảo"]) is None
    assert sanitize_comment("https://x.com 0987654321", []) is None


def test_split_text_respects_vbee_limit():
    text = "Câu một rất dài. " * 40
    parts = split_text(text)
    assert all(len(p) <= 300 for p in parts) and " ".join(parts) == " ".join(text.split())


@pytest.mark.anyio
async def test_vbee_client_sends_documented_request_and_maps_errors():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["headers"], seen["body"] = req.headers, json.loads(req.content)
        if req.headers["App-Id"] == "bad":
            return httpx.Response(401, json={"error": {"code": "UNAUTHORIZED", "message": "invalid token"}})
        if req.headers["App-Id"] == "poor":
            return httpx.Response(400, json={"error": {"code": "BAD_REQUEST", "message": "Not enough credits"}})
        return httpx.Response(200, content=b"ID3fake-mp3", headers={"content-type": "audio/mpeg"})

    t = httpx.MockTransport(handler)
    audio = await VbeeTts("app-1", "tok", transport=t).synth("Xin chào", "hn_female_ngochuyen_full_48k-fhg", 1.1)
    assert audio.data == b"ID3fake-mp3" and audio.ext == "mp3"
    assert str(seen["headers"]["authorization"]) == "Bearer tok" and seen["headers"]["app-id"] == "app-1"
    assert seen["body"] == {"text": "Xin chào", "voiceCode": "hn_female_ngochuyen_full_48k-fhg", "outputFormat": "mp3",
                            "bitrate": 128, "speed": 1.1, "mode": "sync"}
    with pytest.raises(TtsError) as e:
        await VbeeTts("bad", "tok", transport=t).synth("x", "v", 1.0)
    assert e.value.code == "auth"
    with pytest.raises(TtsError) as e:
        await VbeeTts("poor", "tok", transport=t).synth("x", "v", 1.0)
    assert e.value.code == "credit"
