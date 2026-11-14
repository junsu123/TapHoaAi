"""Why a viewer was (not) greeted / a comment (not) read; the computer's own voice when there is no Vbee."""

from __future__ import annotations

import time

from .test_ai_voice import CFG, ScriptedClaude, next_speech, play, setup
from .test_pipeline import game_ws

ON = {"greet_joins": True, "read_comments": True}


def join(c, uid, nick=None):
    c.post("/api/v1/demo/events", json={"type": "JOIN", "unique_id": uid, "nickname": nick or uid})


def say(c, raw):
    c.post("/api/v1/demo/events", json={"raw": raw})


def check(c, cid):
    return next(x for x in c.app.state.container.assistant.checks() if x["id"] == cid)


def test_voice_off_explains_why_nobody_is_greeted(admin_client):
    c = admin_client
    cont = setup(c, ScriptedClaude({}), **ON, voice_enabled=False)
    join(c, "lan", "Lan")
    say(c, "@minh: hôm nay live vui quá")
    time.sleep(0.3)
    trace = list(cont.assistant.trace)
    assert any(t["kind"] == "join" and t["who"] == "Lan" and not t["ok"] and "Phát trên LIVE đang tắt" in t["reason"]
               for t in trace)
    assert any(t["kind"] == "comment" and not t["ok"] and "Phát trên LIVE đang tắt" in t["reason"] for t in trace)
    assert check(c, "voice")["ok"] is False
    assert "Bật phát trên LIVE" in check(c, "voice")["fix"]
    snap = cont.dashboard_snapshot()
    assert snap["voice_trace"] and snap["ai"]["checks"]


def test_without_vbee_the_obs_page_reads_with_the_computer_voice(admin_client):
    c = admin_client
    cont = setup(c, ScriptedClaude({}), **ON)
    cont.speech.provider = None  # no Vbee
    assert check(c, "player")["ok"] is False
    with game_ws(c) as ws:
        ws.receive_json()
        ws.send_json({"type": "PLAYER_INFO", "speech_api": True, "voice_count": 3, "blocked": False,
                      "fallback_voice": "Microsoft An - Vietnamese (Vietnam)",
                      "voices": [{"name": "Microsoft An - Vietnamese (Vietnam)", "lang": "vi-VN", "local": True}]})
        join(c, "lan", "Lan")
        w = next_speech(ws)
        assert w["kind"] == "welcome" and w["url"] is None and w["caption_only"] is True
        assert w["fallback"] == {"name": None, "rate": 1.0, "lang": "vi-VN"}
        play(ws, w)
        assert check(c, "player")["ok"] is True
        audio = check(c, "audio")
        assert audio["ok"] is True and "Microsoft An" in audio["detail"]
        trace = list(cont.assistant.trace)
        assert any(t["kind"] == "welcome" and t["ok"] and "Lan" in t["who"] for t in trace)

        # a computer without a Vietnamese voice: say so and how to fix it
        ws.send_json({"type": "PLAYER_INFO", "speech_api": True, "voice_count": 2, "blocked": False,
                      "fallback_voice": None, "voices": [{"name": "Microsoft David", "lang": "en-US", "local": True}]})
        time.sleep(0.2)
        audio = check(c, "audio")
        assert audio["ok"] is False and "Tiếng Việt" in audio["detail"]

        # the host can turn the computer voice off
        r = c.put("/api/v1/settings/ai", json={"config": {**CFG, **ON, "browser_voice": False}})
        assert r.status_code == 200
        join(c, "minh", "Minh")
        w = next_speech(ws)
        assert w["fallback"] is None


def test_test_line_on_the_live_page(admin_client):
    c = admin_client
    setup(c, ScriptedClaude({}), **ON)
    r = c.post("/api/v1/voice/test-live")
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_player"
    with game_ws(c) as ws:
        ws.receive_json()
        r = c.post("/api/v1/voice/test-live")
        assert r.status_code == 200, r.text
        assert r.json()["how"] == "vbee"
        w = next_speech(ws)
        assert w["kind"] == "test" and "giọng đọc thử" in w["text"]


def test_hello_from_someone_already_welcomed_is_read_as_a_comment(admin_client):
    c = admin_client
    cont = setup(c, ScriptedClaude({}), **ON)
    with game_ws(c) as ws:
        ws.receive_json()
        join(c, "lan", "Lan")
        w = next_speech(ws)
        assert w["kind"] == "welcome"
        play(ws, w)
        say(c, "@lan: chào shop nha")
        w = next_speech(ws)
        assert w["kind"] == "comment" and "chào shop" in w["text"]
        assert any(t["kind"] == "join" and "10 phút" in t["reason"] for t in cont.assistant.trace)
