"""Dance stage (first come, first served), the shop owner's own replies, poems and stories."""

from __future__ import annotations

import time

from app.services.owner_talk import POEMS, STORIES, local_reply
from app.services.text_safety import risky_claims

from .test_pipeline import game_ws, recv_until


def _voice_on(c, **extra):
    cfg = c.get("/api/v1/settings/ai").json()["config"]
    cfg.update(voice_enabled=True, voice_policy_confirmed=True, **extra)
    body = {"config": cfg}
    if extra.get("poem_story_claude"):
        body["claude_api_key"] = "sk-ant-test-1234567890abcd"
    assert c.put("/api/v1/settings/ai", json=body).status_code == 200
    c.post("/api/v1/voice/unmute")


def _until(fn, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError("timeout")


# ---------------------------------------------------------------- stage
def test_first_comment_dances_first_and_the_line_moves(admin_client):
    c = admin_client
    cont = c.app.state.container
    cont.scene = cont.scene.model_copy(update={"stage_seconds": 8})
    with game_ws(c) as ws:
        ws.receive_json()
        for who in ("an", "binh", "chi"):
            c.post("/api/v1/demo/events", json={"raw": f"@{who}: chào shop"})
        for who in ("binh", "an", "chi", "binh"):  # binh first; binh again keeps the place
            c.post("/api/v1/demo/events", json={"raw": f"@{who}: đăng ký nhảy"})
        perform, _ = recv_until(ws, lambda m: m.get("type") == "STAGE_PERFORM", limit=500)
        assert perform["name"] == "Binh" or perform["name"].lower() == "binh"
        v = c.get("/api/v1/stage").json()
        assert [q["name"].lower() for q in v["queue"]] == ["an", "chi"]
        assert v["current"]["name"].lower() == "binh" and v["current"]["phase"] == "calling"
        # no product command for a dancer: it waits until the dance is over
        av = perform["avatar_id"]
        assert cont.stage.holds(av)
        # the game page: on stage → dancing for stage_seconds, then STAGE_END and the next one
        ws.send_json({"type": "STAGE_PROGRESS", "token": perform["token"], "phase": "on_stage"})
        _until(lambda: c.get("/api/v1/stage").json()["current"]["phase"] == "dancing")
        cont.stage.current.ends_at = 0  # (instead of waiting 8 s)
        end, _ = recv_until(ws, lambda m: m.get("type") == "STAGE_END", limit=500)
        assert end["avatar_id"] == av
        nxt, _ = recv_until(ws, lambda m: m.get("type") == "STAGE_PERFORM", limit=500)
        assert nxt["name"].lower() == "an"
    assert cont.stage.performed == 1
    # dancing again right away is not possible
    assert cont.stage.register(cont.avatars.get(av) and _user("binh"), "binh") == "again_later"


def _user(n):
    from app.events.schema import EventUser

    return EventUser(platform_user_id=f"demo_{n}", unique_id=n, nickname=n)


def test_stage_line_is_bounded_and_skips_those_who_left(admin_client):
    c = admin_client
    cont = c.app.state.container
    cont.scene = cont.scene.model_copy(update={"stage_max_queue": 5})
    c.post("/api/v1/demo/start")
    cont.stage._gap_until = time.monotonic() + 3600  # nobody is called while we look at the line
    for i in range(7):
        assert cont.stage.register(_user(f"v{i}"), f"v{i}") == ("queued" if i < 5 else "full")
    assert cont.stage.remove(_user("v2").identity_key)
    assert [e.name for e in cont.stage.queue] == ["v0", "v1", "v3", "v4"]
    # "về thôi" also leaves the line
    c.post("/api/v1/demo/events", json={"raw": "@v3: chào"})
    cont.stage.register(_user("v3"), "v3")
    c.post("/api/v1/demo/events", json={"raw": "@v3: về thôi"})
    _until(lambda: "v3" not in [e.name for e in cont.stage.queue])
    # nobody shows up (no game page): skipped after the timeout, the line goes on
    cont.stage._gap_until = 0
    cont.stage.tick()
    assert cont.stage.current is not None
    cont.stage.current.since -= 31
    cont.stage.tick()
    assert cont.stage.skipped >= 1
    assert c.post("/api/v1/stage/clear").json()["waiting"] == 0


def test_stage_off_dances_in_place(admin_client):
    c = admin_client
    cont = c.app.state.container
    cont.scene = cont.scene.model_copy(update={"stage_enabled": False})
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@dung: nhảy đi"})
        recv_until(ws, lambda m: m.get("type") == "SOCIAL_EFFECT" and m.get("kind") == "dance")
    assert not cont.stage.queue


# ---------------------------------------------------------------- the owner talks
def test_owner_answers_small_talk_without_claude():
    assert "Lan" in local_reply("đẹp quá shop ơi", "Lan")
    assert local_reply("cảm ơn shop nha", "An")
    assert local_reply("hôm nay đi làm về muộn", "An") is None  # → Claude
    assert local_reply("chốt đơn", "An").startswith("Dạ An bấm vào giỏ hàng")


def test_owner_reads_and_answers_a_comment_by_itself(admin_client):
    c = admin_client
    cont = c.app.state.container
    _voice_on(c)
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@hoa: live hôm nay vui quá"})
        first, _ = recv_until(ws, lambda m: m.get("type") == "SPEECH", limit=500)
        assert first["clip"]["text"] == "Bạn hoa nói: live hôm nay vui quá"
        ws.send_json({"type": "SPEECH_STARTED", "id": first["clip"]["id"]})
        ws.send_json({"type": "SPEECH_ENDED", "id": first["clip"]["id"]})
        ans, _ = recv_until(ws, lambda m: m.get("type") == "SPEECH", limit=500)
        assert ans["clip"]["kind"] == "answer" and "hoa" in ans["clip"]["text"].lower()
    item = next(i for i in cont.assistant.items.values() if i.get("nickname") == "hoa")
    assert item["draft_source"] == "owner" and item["spoken"]


# ---------------------------------------------------------------- poems & stories
def test_builtin_poems_and_stories_are_safe():
    for t in POEMS + STORIES:
        assert not risky_claims(t), t
    for p in POEMS:
        assert len([ln for ln in p.splitlines() if ln.strip()]) == 4


def test_viewer_asks_for_a_poem_and_a_story(admin_client):
    c = admin_client
    cont = c.app.state.container
    _voice_on(c)
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@mai: làm thơ đi shop"})
        poem, _ = recv_until(ws, lambda m: m.get("type") == "SPEECH" and m["clip"]["kind"] == "poem", limit=800)
        assert poem["clip"]["text"].startswith("Tặng mai một bài thơ nhỏ:")
        assert poem["clip"]["label"] == "Chủ quán làm thơ"
    # asking again at once: wait
    c.post("/api/v1/demo/events", json={"raw": "@mai: kể chuyện đi"})
    _until(lambda: any(r.get("text") == "kể chuyện đi" for r in cont.orchestrator.recent_comments))
    rec = [r for r in cont.orchestrator.recent_comments if r.get("text") == "kể chuyện đi"][-1]
    assert rec["action_outcome"] in ("story_again_later", "story_too_soon")
    # the host asks for a story now
    r = c.post("/api/v1/talk/now", json={"kind": "story"})
    assert r.json()["outcome"] == "story_queued"
    _until(lambda: any(h["kind"] == "story" for h in cont.talk.history))


def test_poem_written_by_claude_is_checked(admin_client):
    c = admin_client
    cont = c.app.state.container
    _voice_on(c, poem_story_claude=True)
    from app.services.assistant import FakeClaude

    cont.assistant.client = FakeClaude()
    c.post("/api/v1/talk/now", json={"kind": "poem"})
    h = _until(lambda: [x for x in cont.talk.history if x["kind"] == "poem"])
    assert h[-1]["source"] == "claude"  # the offline stand-in in tests
    assert not risky_claims(h[-1]["text"])


def test_now_and_then_when_quiet(admin_client):
    c = admin_client
    cont = c.app.state.container
    # a long time with the voice off is not "quiet time": switching it on never starts with a poem
    cont.speech.last_activity -= 3600
    cont.talk._last_auto = time.monotonic() - 3600
    assert cont.talk.tick() is False
    assert time.monotonic() - cont.talk._last_auto < 5
    _voice_on(c)
    c.post("/api/v1/demo/start")
    t = cont.talk
    t._last_auto = time.monotonic()
    time.sleep(6)
    assert not t.history  # just started: not yet
    t._last_auto -= 9 * 60  # 9 quiet minutes later (the owner looks every 5 s)
    t._last_any -= 120
    cont.speech.last_activity -= 9 * 60
    _until(lambda: len(t.history) == 1, timeout=12)
    assert t.history[0]["kind"] == "poem"
