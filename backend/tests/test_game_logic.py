"""AvatarManager + GameActionQueue + CameraDirector with a fake clock (T06, T07, T10, C3, C4)."""

import pytest

from app.events.schema import EventUser
from app.services.action_queue import CmdStatus, GameActionQueue
from app.services.avatar_manager import AvatarManager
from app.services.camera_director import CameraDirector
from app.websocket.hub import RecordingHub


@pytest.fixture
def world(catalog, clock):
    hub = RecordingHub(primary=True)
    camera = CameraDirector(hub, min_hold=4.0, clock=clock)
    avatars = AvatarManager(hub, max_visible=60, clock=clock)
    actions = GameActionQueue(hub, catalog, camera, cooldown=5.0, max_pending=2, clock=clock,
                              reservation_ttl=15.0, ack_timeout=5.0, action_timeout=45.0)
    avatars.is_busy = actions.is_busy
    actions.is_avatar_visible = lambda a: avatars.get(a) is not None and avatars.get(a).visible
    avatars.reset("live_test")
    actions.reset("live_test")

    class W:
        pass

    w = W()
    w.hub, w.camera, w.avatars, w.actions, w.clock = hub, camera, avatars, actions, clock
    return w


def user(n: str) -> EventUser:
    return EventUser(platform_user_id=f"uid_{n}", unique_id=n, nickname=n.title())


def client_runs(w, cmd, outcome="ACTION_COMPLETED"):
    for t in ("ACK", "ACTION_STARTED", "ACTION_PROGRESS", outcome):
        w.actions.on_client_message({"type": t, "command_id": cmd.command_id})


# ---------------------------------------------------------------- avatars
def test_one_avatar_per_user_even_with_same_nickname(world):
    a1 = world.avatars.get_or_create(user("lananh88"))
    a2 = world.avatars.get_or_create(user("lananh88"))
    other = world.avatars.get_or_create(EventUser(platform_user_id="uid_x", nickname="Lananh88"))
    assert a1 is a2 and other.avatar_id != a1.avatar_id
    assert len(world.hub.of_type("AVATAR_SPAWN")) == 2


def test_anonymous_events_never_create_avatar(world):
    assert world.avatars.get_or_create(EventUser(nickname="chỉ có nickname")) is None
    assert world.avatars.get_or_create(None) is None


def test_avatar_identity_is_deterministic(world):
    a = world.avatars.get_or_create(user("lananh88"))
    world.avatars.reset("live_test")
    b = world.avatars.get_or_create(user("lananh88"))
    assert (a.avatar_id, a.appearance_seed) == (b.avatar_id, b.appearance_seed)


def test_visible_cap_evicts_idle_and_queues_when_all_busy(world, catalog):
    world.avatars.max_visible = 2
    a = world.avatars.get_or_create(user("a"))
    world.clock.advance(1)
    b = world.avatars.get_or_create(user("b"))
    world.actions.submit(a.avatar_id, a.viewer_key, "TRA_CA_GAI_LEO")
    world.actions.submit(b.avatar_id, b.viewer_key, "TRA_BA_KICH")
    c = world.avatars.get_or_create(user("c"))  # both busy → overflow, no event lost
    assert not c.visible and list(world.avatars.overflow) == [c.viewer_key]
    cmd_a = world.actions.queues[a.avatar_id].active
    client_runs(world, cmd_a)
    world.avatars.tick()  # a is idle now → leaves, c enters
    assert c.visible and not a.visible
    assert len(world.avatars.visible()) == 2


# ---------------------------------------------------------------- action queue
def test_comment_produces_walk_pickup_show_for_right_shelf(world):
    """T03 (backend half): command targets KE_02 / TRA_CA_GAI_LEO for the right avatar."""
    av = world.avatars.get_or_create(user("lananh88"))
    cmd, outcome = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    assert outcome == "queued" and cmd.status == CmdStatus.DISPATCHED
    [wire] = world.hub.of_type("CHARACTER_ACTION")
    assert wire["avatar_id"] == av.avatar_id
    assert (wire["product_id"], wire["shelf_id"], wire["slot_id"]) == ("TRA_CA_GAI_LEO", "KE_02", "S2")
    assert wire["action"] == "WALK_PICKUP_SHOW" and wire["parameters"]["show_seconds"] == 8.0
    assert world.hub.of_type("CAMERA_FOCUS")[-1]["avatar_id"] == av.avatar_id
    client_runs(world, cmd)
    assert cmd.status == CmdStatus.COMPLETED
    assert world.actions.reservations.occupied("KE_02") == 0


def test_not_completed_without_client_confirmation(world):
    av = world.avatars.get_or_create(user("lananh88"))
    cmd, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    world.actions.on_client_message({"type": "ACK", "command_id": cmd.command_id})
    assert cmd.status == CmdStatus.ACKED  # never COMPLETED on our own


def test_same_user_two_products_in_one_second(world):
    """T06 / C3: no second avatar, preempt current, never two boxes at once, cooldown 5 s."""
    av = world.avatars.get_or_create(user("a"))
    c1, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    world.actions.on_client_message({"type": "ACK", "command_id": c1.command_id})
    world.clock.advance(1)
    av_again = world.avatars.get_or_create(user("a"))
    c2, outcome = world.actions.submit(av_again.avatar_id, av.viewer_key, "TRA_BA_KICH")
    assert av_again is av and world.avatars.count == 1
    assert outcome == "queued" and c2.status == CmdStatus.QUEUED
    assert world.hub.of_type("PREEMPT")[0]["command_id"] == c1.command_id
    assert len(world.hub.of_type("CHARACTER_ACTION")) == 1  # only one running at a time
    world.actions.on_client_message({"type": "ACTION_COMPLETED", "command_id": c1.command_id, "reason": "preempted"})
    assert c2.status == CmdStatus.QUEUED  # cooldown: 5 s since c1 started
    world.clock.advance(4.1)
    world.actions.tick()
    assert c2.status == CmdStatus.DISPATCHED
    assert len(world.hub.of_type("CHARACTER_ACTION")) == 2


def test_duplicate_product_comment_is_merged(world):
    av = world.avatars.get_or_create(user("a"))
    c1, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    c2, outcome = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    assert c1 is c2 and outcome == "merged"


def test_pending_bounded_to_two_newest_wins(world):
    world.actions.reset("live_test")
    av = world.avatars.get_or_create(user("a"))
    world.hub.primary = False  # nothing dispatches → everything stays pending
    cmds = [world.actions.submit(av.avatar_id, av.viewer_key, p)[0]
            for p in ("TRA_CA_GAI_LEO", "TRA_BA_KICH")]
    # a third distinct product needs a third catalog entry; emulate with re-submits
    q = world.actions.queues[av.avatar_id]
    assert len(q.pending) == 2
    world.actions.max_pending = 1
    c3, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    assert c3 is cmds[0]  # merged with the pending one


def test_four_users_same_product_queue_at_stand_positions(world):
    """T07 / C4: 3 stand positions; the 4th waits beside the shelf, then gets served."""
    avs = [world.avatars.get_or_create(user(f"u{i}")) for i in range(4)]
    cmds = [world.actions.submit(a.avatar_id, a.viewer_key, "TRA_CA_GAI_LEO")[0] for a in avs]
    assert [c.status for c in cmds[:3]] == [CmdStatus.DISPATCHED] * 3
    assert sorted(c.stand_index for c in cmds[:3]) == [0, 1, 2]
    assert cmds[3].status == CmdStatus.WAITING_SLOT
    [wait] = world.hub.of_type("WAIT_NEAR_SHELF")
    assert wait["avatar_id"] == avs[3].avatar_id and wait["shelf_id"] == "KE_02"
    client_runs(world, cmds[1])
    assert cmds[3].status == CmdStatus.DISPATCHED and cmds[3].stand_index == cmds[1].stand_index
    stands = [c.stand_index for c in cmds if c.status != CmdStatus.COMPLETED]
    assert len(stands) == len(set(stands))  # never two avatars on one spot


def test_no_ack_resends_then_times_out_and_resets(world):
    av = world.avatars.get_or_create(user("a"))
    cmd, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    world.clock.advance(5.1)
    world.actions.tick()
    assert len(world.hub.of_type("CHARACTER_ACTION")) == 2  # same command_id resent
    assert len({m["command_id"] for m in world.hub.of_type("CHARACTER_ACTION")}) == 1
    world.clock.advance(5.1)
    world.actions.tick()
    assert cmd.status == CmdStatus.TIMED_OUT
    assert world.hub.of_type("RESET_AVATAR")[0]["avatar_id"] == av.avatar_id
    assert world.actions.reservations.occupied("KE_02") == 0


def test_stuck_action_times_out(world):
    av = world.avatars.get_or_create(user("a"))
    cmd, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    world.actions.on_client_message({"type": "ACK", "command_id": cmd.command_id})
    world.actions.on_client_message({"type": "ACTION_STARTED", "command_id": cmd.command_id})
    for _ in range(4):  # client keeps reporting progress, but never finishes
        world.clock.advance(12)
        world.actions.on_client_message({"type": "ACTION_PROGRESS", "command_id": cmd.command_id})
        world.actions.tick()
    assert cmd.status == CmdStatus.TIMED_OUT and cmd.reason == "action_timeout"


def test_client_failure_releases_everything(world):
    av = world.avatars.get_or_create(user("a"))
    cmd, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    client_runs(world, cmd, outcome="ACTION_FAILED")
    assert cmd.status == CmdStatus.FAILED
    assert not world.actions.is_busy(av.avatar_id)
    assert world.actions.reservations.occupied("KE_02") == 0


def test_without_renderer_commands_wait_instead_of_failing(world):
    world.hub.primary = False
    av = world.avatars.get_or_create(user("a"))
    cmd, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
    world.clock.advance(30)
    world.actions.tick()
    assert cmd.status == CmdStatus.QUEUED
    world.hub.primary = True
    world.actions.tick()
    assert cmd.status == CmdStatus.DISPATCHED


def test_product_without_shelf_is_reported(world, catalog):
    av = world.avatars.get_or_create(user("a"))
    catalog.locations.pop("TRA_BA_KICH")
    cmd, outcome = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_BA_KICH")
    assert cmd is None and outcome == "no_location"


# ---------------------------------------------------------------- camera
def test_camera_holds_shot_and_queues_equal_priority(world):
    a = world.avatars.get_or_create(user("a"))
    b = world.avatars.get_or_create(user("b"))
    ca, _ = world.actions.submit(a.avatar_id, a.viewer_key, "TRA_CA_GAI_LEO")
    cb, _ = world.actions.submit(b.avatar_id, b.viewer_key, "TRA_BA_KICH")
    focus = [m for m in world.hub.of_type("CAMERA_FOCUS") if m["mode"] == "follow"]
    assert [m["avatar_id"] for m in focus] == [a.avatar_id]  # b waits its turn
    world.clock.advance(1)
    client_runs(world, ca)  # a finishes after 1 s — camera still holds the 4 s minimum
    assert world.camera.current.avatar_id == a.avatar_id
    world.clock.advance(3.1)
    world.camera.tick()
    assert world.camera.current.avatar_id == b.avatar_id
    client_runs(world, cb)
    world.clock.advance(4.1)
    world.camera.tick()
    assert world.camera.current is None
    assert world.hub.of_type("CAMERA_FOCUS")[-1]["mode"] == "overview"
