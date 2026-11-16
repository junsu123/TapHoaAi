"""High viewership: the server keeps up, sheds only optional work, slow screens never hold the
others back, Chibis come in at a steady pace and the database is written in batches."""

from __future__ import annotations

import asyncio
import time

import pytest

from app.models import LiveEventRow, Viewer
from app.services.avatar_manager import MIN_STAY_S, SPAWN_BURST, VIP_MIN_STAY_S, AvatarManager
from app.services.health import BUSY, OK, OVERLOADED, ServerHealth, TokenBucket
from app.websocket.hub import OUTBOX_LIMIT, Channel
from app.websocket.hub import RecordingHub

from .conftest import FakeClock
from .test_game_logic import client_runs, user, world  # noqa: F401
from .test_pipeline import game_ws, recv_until


# ---------------------------------------------------------------- websocket hub
class FakeWs:
    def __init__(self, delay: float = 0.0):
        self.frames: list[dict] = []
        self.delay = delay
        self.closed: int | None = None

    async def send_json(self, data):
        if self.delay:
            await asyncio.sleep(self.delay)
        self.frames.append(data)

    async def close(self, code: int = 1000, reason: str = ""):
        self.closed = code

    def messages(self) -> list[dict]:
        out = []
        for f in self.frames:
            out.extend(f["messages"] if f.get("type") == "BATCH" else [f])
        return out


async def test_messages_are_batched_in_order():
    ch = Channel("game", coalesce=0.02)
    ch.start()
    ws = FakeWs()
    ch.add(ws, "primary")
    for i in range(50):
        ch.enqueue({"type": "X", "i": i})
    await asyncio.sleep(0.1)
    msgs = ws.messages()
    assert [m["i"] for m in msgs] == list(range(50))
    assert [m["sequence"] for m in msgs] == list(range(1, 51))
    assert len(ws.frames) <= 3  # 50 messages, a couple of frames
    await ch.stop()


async def test_a_slow_screen_never_holds_back_the_others():
    ch = Channel("dashboard", coalesce=0.0)
    ch.start()
    fast, stuck = FakeWs(), FakeWs(delay=10.0)  # a frozen laptop on bad Wi-Fi
    ch.add(fast, "viewer")
    ch.add(stuck, "viewer")
    for i in range(OUTBOX_LIMIT["viewer"] + 10):
        ch.enqueue({"type": "COMMENT", "i": i})
        if i % 200 == 0:
            await asyncio.sleep(0)
    await asyncio.sleep(0.2)
    assert len(fast.messages()) == OUTBOX_LIMIT["viewer"] + 10  # got everything, on time
    assert stuck.closed == 4408 and stuck not in ch.clients  # told to reconnect for a snapshot
    assert ch.kicked_slow == 1
    await ch.stop()


# ---------------------------------------------------------------- health / shedding
def test_load_level_rises_fast_and_calms_down_slowly():
    clock = FakeClock()

    class Bus:
        depth = 0
        queue = type("Q", (), {"maxsize": 2000})()

    bus = Bus()
    h = ServerHealth(bus, clock=clock)
    h.sample()
    assert h.level == OK
    bus.depth = 400
    h.sample()
    assert h.level == BUSY
    bus.depth = 1500
    h.sample()
    assert h.level == OVERLOADED and h.overloaded
    bus.depth = 0
    clock.advance(1)
    h.sample()
    assert h.level == OVERLOADED  # not flapping
    clock.advance(6)
    h.sample()
    assert h.level == OK
    h.event_handled(clock() - 0.05)
    assert h.view()["event_lag_ms_p95"] == pytest.approx(50.0, abs=1)


def test_token_bucket():
    clock = FakeClock()
    b = TokenBucket(2.0, 3.0, clock=clock)
    assert [b.allow() for _ in range(4)] == [True, True, True, False]
    clock.advance(0.5)
    assert b.allow() and not b.allow()


# ---------------------------------------------------------------- Chibis entering
def test_chibis_come_in_at_a_steady_pace_and_stay_a_while():
    clock = FakeClock()
    hub = RecordingHub()
    m = AvatarManager(hub, max_visible=20, idle_exit_seconds=360, clock=clock)
    m.reset("s1")
    for i in range(40):
        m.get_or_create(user(f"v{i}"))
    assert len(m.visible()) == SPAWN_BURST  # not 20 at once
    assert len(m.overflow) == 40 - SPAWN_BURST
    for _ in range(10):
        clock.advance(1.0)
        m.tick()
    assert len(m.visible()) == 20  # full, at about 3 a second
    # the shop is full: those still waiting only come in when someone has stayed a while
    spawned = len(hub.of_type("AVATAR_SPAWN"))
    clock.advance(1.0)
    m.tick()
    assert len(hub.of_type("AVATAR_SPAWN")) == spawned and not hub.of_type("AVATAR_EXIT")
    clock.advance(MIN_STAY_S)
    m.tick()
    assert hub.of_type("AVATAR_EXIT")[-1]["reason"] == "make_room"
    assert len(m.visible()) == 20


def test_full_shop_only_watching_viewers_wait_for_a_comment():
    clock = FakeClock()
    m = AvatarManager(RecordingHub(), max_visible=10, idle_exit_seconds=360, clock=clock)
    m.reset("s1")
    for i in range(10):
        m.get_or_create(user(f"c{i}"))
    j = m.get_or_create(user("joiner"), reason="join")
    assert not j.visible and j.viewer_key not in m.overflow and m.not_shown_joins == 1
    c = m.get_or_create(user("joiner"), reason="comment")  # now they talk: in the line
    assert c is j and j.viewer_key in m.overflow


# ---------------------------------------------------------------- batched database writes
def test_events_and_viewers_are_written_in_batches(admin_client):
    c = admin_client
    cont = c.app.state.container
    for i in range(30):
        c.post("/api/v1/demo/events", json={"raw": f"@kh{i % 5}: chào shop {i}"})
    c.post("/api/v1/demo/events", json={"type": "LIKE", "unique_id": "kh1", "nickname": "kh1", "count": 3})
    deadline = time.time() + 5
    while time.time() < deadline and cont.orchestrator.counts.get("LIKE", 0) < 1:
        time.sleep(0.05)
    cont.writer.flush_sync()
    with cont.db.session() as s:
        types = [r.type for r in s.query(LiveEventRow).filter_by(session_id=cont.live.session_id)]
        viewers = s.query(Viewer).filter_by(session_id=cont.live.session_id).count()
    assert types.count("COMMENT") == 30 and "LIKE" not in types  # likes are counted, not stored one by one
    assert viewers == 5
    assert cont.writer.batches < 30  # far fewer transactions than events


# ---------------------------------------------------------------- end to end burst
def test_a_burst_of_1000_events_is_absorbed(admin_client):
    c = admin_client
    cont = c.app.state.container
    with game_ws(c) as ws:
        ws.receive_json()
        r = c.post("/api/v1/game/loadtest", json={"rate": 200, "seconds": 5, "viewers": 800})
        assert r.status_code == 200, r.text
        deadline = time.time() + 15
        while time.time() < deadline:
            h = c.get("/api/v1/system/health").json()
            if h["loadtest"]["done"] and h["server"]["bus_depth"] == 0:
                break
            time.sleep(0.2)
        h = c.get("/api/v1/system/health").json()
        assert h["loadtest"]["sent"] >= 950
        assert h["server"]["bus_depth"] == 0
        assert len(cont.avatars.visible()) <= cont.avatars.max_visible
        assert cont.orchestrator.errors == 0
        ws.send_json({"type": "PING"})
        recv_until(ws, lambda m: m.get("type") == "PONG", limit=20000)  # the game page still answers
    m = c.get("/api/v1/metrics").json()
    assert m["server"]["db"]["pending"] < 2000


def test_loadtest_is_demo_only_and_bounded(admin_client):
    c = admin_client
    assert c.post("/api/v1/game/loadtest", json={"rate": 5000, "seconds": 10}).status_code == 422
    assert c.post("/api/v1/game/loadtest/stop").status_code == 200


def test_a_buyer_gets_in_even_when_the_shop_is_full_of_chatters():
    """Everyone on screen keeps chatting: a viewer asking for a product still gets a Chibi
    (taking the place of one that has been here a while), and comes before chatters."""
    clock = FakeClock()
    hub = RecordingHub()
    m = AvatarManager(hub, max_visible=10, idle_exit_seconds=360, clock=clock)
    m.reset("s1")
    for i in range(10):
        m.get_or_create(user(f"c{i}"))
    clock.advance(VIP_MIN_STAY_S + 1)
    for i in range(10):
        m.get_or_create(user(f"c{i}"))  # all still chatting
    chatter = m.get_or_create(user("chatter"))
    buyer = m.get_or_create(user("buyer"), reason="product")
    assert buyer.visible and not chatter.visible  # the buyer is in at once
    assert hub.of_type("AVATAR_EXIT")[-1]["reason"] == "make_room"
    clock.advance(5)
    m.tick()
    assert not chatter.visible  # chatters still wait for someone quiet


def test_long_busy_live_memory_stays_bounded(world):  # noqa: F811
    """Viewers long gone are forgotten (and come back as the same Chibi); finished commands
    are dropped from memory after a while."""
    from app.services import action_queue as aq
    from app.services import avatar_manager as am

    m = world.avatars
    first = m.get_or_create(user("returning"))
    seed = first.appearance_seed
    for i in range(am.KEEP_VIEWERS + 50):
        m.get_or_create(user(f"x{i}"), reason="join")
    world.clock.advance(am.FORGET_AFTER_S + 31)
    m.tick()
    assert len(m._by_key) < am.KEEP_VIEWERS
    back = m.get_or_create(user("returning"))
    assert back.avatar_id == first.avatar_id and back.appearance_seed == seed

    world.actions.cooldown = 0
    av = m.get_or_create(user("buyer"))
    for _ in range(aq.KEEP_FINISHED + 30):
        cmd, _ = world.actions.submit(av.avatar_id, av.viewer_key, "TRA_CA_GAI_LEO")
        client_runs(world, cmd)
    assert len(world.actions.commands) <= aq.KEEP_FINISHED + 5
