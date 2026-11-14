"""Every viewer who joins is greeted by name; comments are read; captions when there is no voice."""

from __future__ import annotations

import re
import time

import httpx

from app.services.tts_vbee import FakeTts, TtsError, VbeeTts

from .test_ai_voice import CFG, ScriptedClaude, next_speech, play, setup
from .test_pipeline import game_ws

ON = {"greet_joins": True, "read_comments": True}


def join(c, uid, nick=None):
    c.post("/api/v1/demo/events", json={"type": "JOIN", "unique_id": uid, "nickname": nick or uid})


def test_one_viewer_joins_and_is_greeted_by_name(admin_client):
    c = admin_client
    setup(c, ScriptedClaude({}), **ON)
    with game_ws(c) as ws:
        ws.receive_json()
        join(c, "lan_anh", "Lan Anh")
        w = next_speech(ws)
        assert w["kind"] == "welcome" and "Lan Anh" in w["text"] and "Mộc Tâm" in w["text"]
        play(ws, w)
        join(c, "lan_anh", "Lan Anh")  # back within 10 minutes: not greeted twice
        time.sleep(2.6)
        assert not c.app.state.container.speech.queue


def test_many_viewers_at_once_are_all_greeted(admin_client):
    c = admin_client
    cont = setup(c, ScriptedClaude({}), **ON)
    with game_ws(c) as ws:
        ws.receive_json()
        ids = c.post("/api/v1/demo/events", json={"type": "SPAWN_RANDOM", "count": 15, "seed": 7}).json()
        assert len(ids["event_ids"] if isinstance(ids, dict) else ids) == 15
        names = [v.nickname for v in cont.avatars.all()] if hasattr(cont.avatars, "all") else None
        spoken = ""
        lines = 0
        while lines < 6:
            w = next_speech(ws)
            assert w["kind"] == "welcome"
            spoken += " " + w["text"]
            lines += 1
            play(ws, w)
            time.sleep(0.5)
            if not cont.assistant._welcome_pending and not cont.speech.queue:
                break
        assert 1 < lines <= 4  # gathered: a few lines, not 15
        greeted = re.findall(r"[A-ZĐÀ-Ỹ][^\s,!]* \d{1,2}", spoken)
        assert len(set(greeted)) == 15, spoken  # every single one, by name
        if names:
            assert all(n in spoken for n in names)


def test_huge_crowd_folds_late_names_into_a_count(admin_client):
    c = admin_client
    cont = setup(c, ScriptedClaude({}), **ON)
    a = cont.assistant
    t0 = time.monotonic()
    a._welcome_pending = [(f"Bạn{i}", f"k{i}", t0 - 120) for i in range(30)]  # everyone waited 2 minutes
    for _ in range(50):  # the welcome loop picks them up
        if cont.speech.queue:
            break
        time.sleep(0.05)
    clip = cont.speech.queue[-1]
    assert clip.kind == "welcome" and "và 18 bạn khác" in clip.text  # 12 names + everyone else, nobody left out
    assert a._welcome_pending == []


def test_ordinary_comments_are_read_aloud(admin_client):
    c = admin_client
    setup(c, ScriptedClaude({}), **ON)  # autopilot off: reading does not need it
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@vy: hôm nay shop đẹp quá"})
        cm = next_speech(ws)
        assert cm["kind"] == "comment" and cm["text"] == "Bạn vy nói: hôm nay shop đẹp quá"
        play(ws, cm)
        c.post("/api/v1/demo/events", json={"raw": "@vy: hôm nay shop đẹp quá"})  # same again at once: skipped
        c.post("/api/v1/demo/events", json={"raw": "@xau: đồ lừa đảo"})  # banned: never read
        time.sleep(0.4)
        assert not c.app.state.container.speech.queue
    log = {t["nickname"]: t for t in c.get("/api/v1/conversations").json()["items"]}
    assert log["vy"]["status"] == "Đã đọc to"


def test_captions_still_show_when_there_is_no_voice(admin_client):
    c = admin_client
    cont = setup(c, ScriptedClaude({}), **ON)
    cont.speech.provider = None  # Vbee not set up
    with game_ws(c) as ws:
        ws.receive_json()
        join(c, "minh", "Minh")
        w = next_speech(ws)
        assert w["url"] is None and w["caption_only"] and "Minh" in w["text"]
        play(ws, w)
    assert "chỉ hiện phụ đề" in c.get("/api/v1/voice/state").json()["ai"]["audio_note"]


def test_vbee_failure_turns_to_captions_and_pauses_calls(admin_client):
    c = admin_client
    cont = setup(c, ScriptedClaude({}), **ON)
    calls = []

    def refuse(req: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(400, json={"error": {"message": "voiceCode không tồn tại"}})

    cont.speech.provider = VbeeTts("app", "tok", transport=httpx.MockTransport(refuse))
    with game_ws(c) as ws:
        ws.receive_json()
        join(c, "a1", "An")
        w1 = next_speech(ws)
        assert w1["caption_only"] and "An" in w1["text"]
        play(ws, w1)
        join(c, "b2", "Bình")
        w2 = next_speech(ws)
        assert w2["caption_only"] and "Bình" in w2["text"]
        play(ws, w2)
    assert len(calls) == 1  # Vbee asked once; for a minute after that, captions only
    note = c.get("/api/v1/voice/state").json()["speech"]["caption_only"]
    assert note and "voiceCode không tồn tại" in note
    errs = c.get("/api/v1/logs").json()["items"]
    assert any("voiceCode không tồn tại" in e["message"] for e in errs)
    assert TtsError and FakeTts and CFG
