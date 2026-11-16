"""Chibi behaviour spec V3 — server side: comment → command mapping, debounce, leave/return,
context questions, camera focus limit, telemetry milestones, replay safety (T05, T08, T11, T13,
T14, T18, T19, T20)."""

from __future__ import annotations

import time

import pytest

from app.services.intent_router import CommentIntentRouter, IntentKind
from app.services.product_matcher import ProductMatcher

from .test_game_logic import client_runs, user, world  # noqa: F401  (fixture)
from .test_pipeline import game_ws, recv_until


@pytest.fixture
def router(catalog):
    return CommentIntentRouter(ProductMatcher(catalog))


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("về thôi", IntentKind.LEAVE),
        ("tạm biệt shop nha", IntentKind.LEAVE),
        ("bye", IntentKind.LEAVE),
        ("về", IntentKind.LEAVE),
        ("đi dạo đi", IntentKind.EXPLORE),
        ("ngồi nghỉ chút", IntentKind.SIT),
        ("tạo dáng đi", IntentKind.POSE),
        ("nhảy đi", IntentKind.DANCE),
        ("chào shop", IntentKind.GREETING),
        # ordinary sentences never move anybody
        ("vệ sinh sạch sẽ ghê", IntentKind.NONE),
        ("hàng về chưa shop", IntentKind.QUESTION),
        ("người nhà mình thích lắm", IntentKind.NONE),
        ("hôm qua mình đi dạo công viên rồi mới vào live nè", IntentKind.NONE),
    ],
)
def test_direct_command_words(router, text, kind):
    assert router.route(text).kind == kind


def test_product_names_still_win(router):
    assert router.route("cà gai leo đâu shop").product_id == "TRA_CA_GAI_LEO"
    assert router.route("trà ba kích").product_id == "TRA_BA_KICH"
    assert router.route("trà").kind == IntentKind.AMBIGUOUS  # T19: never a random product


def test_spam_is_debounced_and_likes_are_batched(admin_client):
    """T08: 100 identical comments in a burst → one dance; 50 likes → one heart."""
    c = admin_client
    cont = c.app.state.container
    cont.scene = cont.scene.model_copy(update={"stage_enabled": False})  # dance in place (no stage)
    with game_ws(c) as ws:
        ws.receive_json()
        for _ in range(100):
            c.post("/api/v1/demo/events", json={"raw": "@spammer: nhảy đi"})
        for _ in range(50):
            c.post("/api/v1/demo/events", json={"type": "LIKE", "unique_id": "spammer", "nickname": "spammer"})
        c.post("/api/v1/demo/events", json={"raw": "@spammer: trà cà gai leo"})  # marker: ends the burst
        _, msgs = recv_until(ws, lambda m: m.get("type") == "CHARACTER_ACTION", limit=600)
        effects = [m for m in msgs if m.get("type") == "SOCIAL_EFFECT"]
        assert [m["kind"] for m in effects].count("dance") == 1
        assert [m["kind"] for m in effects].count("like") == 1
    orch = c.app.state.container.orchestrator
    assert orch.intent_counts["DANCE"] == 100  # every comment is still counted / shown


def test_leave_then_come_back_as_the_same_chibi(admin_client):
    """LEAVE_WAVE then ARRIVE_RETURN: queue cancelled, slot released, same avatar id/look back."""
    c = admin_client
    cont = c.app.state.container
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@vy: trà cà gai leo"})
        spawn, _ = recv_until(ws, lambda m: m.get("type") == "AVATAR_SPAWN")
        av = spawn["avatar"]["avatar_id"]
        act, _ = recv_until(ws, lambda m: m.get("type") == "CHARACTER_ACTION")
        ws.send_json({"type": "ACK", "command_id": act["command_id"]})
        ws.send_json({"type": "ACTION_STARTED", "command_id": act["command_id"]})
        time.sleep(0.1)
        c.post("/api/v1/demo/events", json={"raw": "@vy: về thôi"})
        ex, _ = recv_until(ws, lambda m: m.get("type") == "AVATAR_EXIT")
        assert ex["avatar_id"] == av and ex["reason"] == "user_leave"
        assert not cont.actions.is_busy(av)
        assert cont.actions.reservations.occupied("KE_02") == 0  # T20: nothing left reserved
        c.post("/api/v1/demo/events", json={"raw": "@vy: chào shop"})
        back, _ = recv_until(ws, lambda m: m.get("type") == "AVATAR_SPAWN")
        assert back["avatar"]["avatar_id"] == av
        assert back["avatar"]["appearance_seed"] == spawn["avatar"]["appearance_seed"]


def test_ambiguous_thinks_and_unplaced_product_is_a_surprise(admin_client):
    c = admin_client
    cont = c.app.state.container
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@minh: trà"})
        eff, msgs = recv_until(ws, lambda m: m.get("type") == "SOCIAL_EFFECT")
        assert eff["kind"] == "think"
        assert not any(m.get("type") == "CHARACTER_ACTION" for m in msgs)
        cont.catalog.locations.pop("TRA_BA_KICH")
        c.post("/api/v1/demo/events", json={"raw": "@minh: trà ba kích"})
        eff, msgs = recv_until(ws, lambda m: m.get("type") == "SOCIAL_EFFECT")
        assert eff["kind"] == "surprise"  # PRODUCT_NOT_FOUND: never a different product
        assert not any(m.get("type") == "CHARACTER_ACTION" for m in msgs)


def test_question_about_the_box_in_hand_points_at_it(admin_client):
    c = admin_client
    with game_ws(c) as ws:
        ws.receive_json()
        c.post("/api/v1/demo/events", json={"raw": "@lan: trà cà gai leo"})
        act, _ = recv_until(ws, lambda m: m.get("type") == "CHARACTER_ACTION")
        ws.send_json({"type": "ACK", "command_id": act["command_id"]})
        ws.send_json({"type": "ACTION_STARTED", "command_id": act["command_id"]})
        time.sleep(0.1)
        c.post("/api/v1/demo/events", json={"raw": "@lan: thành phần có gì vậy shop?"})
        eff, _ = recv_until(ws, lambda m: m.get("type") == "SOCIAL_EFFECT")
        assert eff["kind"] == "point"
    host = c.app.state.container.orchestrator.host_attention[-1]
    assert host["product_id"] == "TRA_CA_GAI_LEO"  # the host / AI knows which product


def test_camera_focus_is_limited_and_milestones_are_logged(world):  # noqa: F811
    a = world.avatars.get_or_create(user("a"))
    cmd, _ = world.actions.submit(a.avatar_id, a.viewer_key, "TRA_CA_GAI_LEO")
    assert world.camera.current.avatar_id == a.avatar_id  # follows the walk …
    for ph in ("PATH_FOUND", "REACHED_SHELF", "PICKED"):
        world.actions.on_client_message({"type": "ACTION_PROGRESS", "command_id": cmd.command_id, "phase": ph})
    world.clock.advance(6.0)
    world.camera.tick()
    assert world.camera.current.avatar_id == a.avatar_id
    world.actions.on_client_message({"type": "ACTION_PROGRESS", "command_id": cmd.command_id, "phase": "PRESENTED"})
    world.clock.advance(4.9)
    world.camera.tick()
    assert world.camera.current.avatar_id == a.avatar_id  # … and the close-up on the box
    world.clock.advance(0.2)
    world.camera.tick()
    assert world.camera.current is None  # T13: camera handed back while the Chibi still presents
    assert world.hub.of_type("CAMERA_FOCUS")[-1]["mode"] == "overview"
    assert cmd.milestones == ["PATH_FOUND", "REACHED_SHELF", "PICKED", "PRESENTED"]
    assert cmd.status.value != "COMPLETED"  # the Chibi is still presenting

    world.actions.on_client_message({"type": "ACTION_PROGRESS", "command_id": cmd.command_id, "phase": "RETURNED"})
    world.actions.on_client_message({"type": "ACTION_COMPLETED", "command_id": cmd.command_id})
    assert cmd.summary()["milestones"][-1] == "RETURNED"


def test_long_walk_does_not_hold_the_camera(world):  # noqa: F811
    a = world.avatars.get_or_create(user("w"))
    world.actions.submit(a.avatar_id, a.viewer_key, "TRA_CA_GAI_LEO")
    world.clock.advance(20.5)
    world.camera.tick()
    assert world.camera.current is None


def test_reconnect_replay_does_not_repeat(admin_client):
    """T14: the same platform event delivered twice (reconnect) acts once."""
    c = admin_client
    cont = c.app.state.container
    ev = {"type": "COMMENT", "unique_id": "replay", "nickname": "replay", "text": "trà cà gai leo", "event_id": "tiktok-comment-12345"}
    with game_ws(c) as ws:
        ws.receive_json()
        for _ in range(3):
            c.post("/api/v1/demo/events", json=ev)
        c.post("/api/v1/demo/events", json={"raw": "@marker: chào shop"})
        _, msgs = recv_until(ws, lambda m: m.get("type") == "AVATAR_SPAWN" and m["avatar"]["nickname"] == "marker")
        assert sum(1 for m in msgs if m.get("type") == "CHARACTER_ACTION") == 1
    assert cont.orchestrator.intent_counts["PRODUCT"] == 1


def test_unidentified_viewer_never_gets_a_chibi(admin_client):
    """T18: no stable id → no avatar, no invented nickname."""
    c = admin_client
    cont = c.app.state.container
    before = cont.avatars.count
    r = c.post("/api/v1/demo/events", json={"type": "COMMENT", "text": "trà cà gai leo"})
    assert r.status_code in (200, 422)
    time.sleep(0.1)
    assert cont.avatars.count == before
