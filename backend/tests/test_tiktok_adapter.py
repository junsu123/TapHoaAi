"""M3 contract tests: the adapter against the REAL TikTokLive 7.0.1 event and error classes,
with a fake network client (TikTok is not reachable from CI). Live verification against a
real stream is a manual step — see docs/provider-limitations.md."""

import asyncio
import time

import httpx
import pytest

tl = pytest.importorskip("TikTokLive")

from TikTokLive.client import errors as tterr  # noqa: E402
from TikTokLive.events import (  # noqa: E402
    CommentEvent, FollowEvent, GiftEvent, JoinEvent, LikeEvent, LiveEndEvent, RoomUserSeqEvent,
)
from TikTokLive.proto import CommonMessageData, Gift, User  # noqa: E402

from app.providers.live_provider import Capability, ProviderStatus  # noqa: E402
from app.providers.tiktoklive_adapter import TikTokLiveAdapter, map_event  # noqa: E402
from app.providers.url_validator import InvalidLiveUrl, resolve_short_link  # noqa: E402

LAN = User(id=7001, nickname="Lan Anh", display_id="lananh88")


def comment(msg_id: int, text: str, user=LAN):
    return CommentEvent(common=CommonMessageData(msg_id=msg_id), user=user, content=text)


# ---------------------------------------------------------------- mapping (contract)
def test_comment_maps_to_f1_raw_event():
    raw = map_event(comment(991, "trà cà gai leo"))
    assert raw["type"] == "COMMENT" and raw["event_id"] == "tt_991"
    assert raw["user"] == {"platform_user_id": "7001", "unique_id": "lananh88", "nickname": "Lan Anh"}
    assert raw["payload"] == {"text": "trà cà gai leo"}


def test_gift_streak_mapping():
    rose = Gift(id=5655, name="Rose", type=1)
    mid = map_event(GiftEvent(common=CommonMessageData(msg_id=1), user=LAN, gift=rose, repeat_count=3, repeat_end=0, group_id=42))
    end = map_event(GiftEvent(common=CommonMessageData(msg_id=2), user=LAN, gift=rose, repeat_count=5, repeat_end=1, group_id=42))
    assert mid["payload"] == {"gift_id": "5655", "gift_name": "Rose", "repeat_count": 3, "repeat_end": False,
                              "streakable": True, "group_id": "42"}
    assert end["payload"]["repeat_end"] is True and end["payload"]["repeat_count"] == 5
    one_off = map_event(GiftEvent(common=CommonMessageData(msg_id=3), user=LAN, gift=Gift(id=9, name="Lion", type=2), repeat_count=1))
    assert one_off["payload"]["streakable"] is False and one_off["payload"]["group_id"] is None


def test_other_events_map():
    assert map_event(LikeEvent(common=CommonMessageData(msg_id=4), user=LAN, count=15))["payload"] == {"count": 15}
    assert map_event(JoinEvent(common=CommonMessageData(msg_id=5), user=LAN))["type"] == "JOIN"
    assert map_event(FollowEvent(common=CommonMessageData(msg_id=6), user=LAN))["type"] == "FOLLOW"
    assert map_event(RoomUserSeqEvent(total=1234))["payload"] == {"count": 1234}
    assert map_event(comment(7, "")) is None
    no_user = map_event(comment(8, "chào", user=None))
    assert no_user["user"] is None  # → no avatar for unidentifiable viewers


# ---------------------------------------------------------------- fake client
class FakeClient:
    """Mimics the TikTokLiveClient surface the adapter uses."""

    def __init__(self, unique_id, sign_api_key, *, fail=None, room_id=7_000_001):
        self.unique_id, self.sign_api_key, self.fail = unique_id, sign_api_key, fail
        self.listeners: dict[type, list] = {}
        self.room_id = room_id
        self._done: asyncio.Future | None = None
        self.disconnected = False

    def add_listener(self, cls, fn):
        self.listeners.setdefault(cls, []).append(fn)

    async def start(self, *, fetch_live_check=True):
        if self.fail is not None:
            raise self.fail
        self._done = asyncio.get_running_loop().create_future()

        async def wait():
            await self._done
        return asyncio.ensure_future(wait())

    async def emit(self, event):
        for fn in self.listeners.get(type(event), []):
            await fn(event)

    async def disconnect(self, close_client=False):
        self.disconnected = True
        if self._done and not self._done.done():
            self._done.set_result(None)

    def drop(self, exc=None):
        if exc:
            self._done.set_exception(exc)
        else:
            self._done.set_result(None)


def make(fail=None):
    holder = {}

    def factory(uid, key):
        holder["client"] = FakeClient(uid, key, fail=fail)
        return holder["client"]
    return factory, holder


async def run_adapter(adapter):
    statuses, raws = [], []

    async def on_status(st, detail):
        statuses.append((st, detail))

    async def on_raw(raw):
        raws.append(raw)
    adapter.on_status, adapter.on_raw_event = on_status, on_raw
    task = asyncio.create_task(adapter.start())
    for _ in range(50):
        await asyncio.sleep(0)
    return task, statuses, raws


@pytest.mark.parametrize("exc,status,needle", [
    (tterr.UserOfflineError(), ProviderStatus.OFFLINE, "không phát LIVE"),  # T01
    (tterr.UserNotFoundError("x"), ProviderStatus.UNSUPPORTED, "Không tìm thấy"),
    (tterr.AgeRestrictedError(), ProviderStatus.UNSUPPORTED, "giới hạn độ tuổi"),
    (tterr.WebcastBlockedError(), ProviderStatus.UNSUPPORTED, "không vượt chặn"),
])
async def test_terminal_failures_show_the_real_reason(exc, status, needle):
    factory, _ = make(fail=exc)
    task, statuses, _ = await run_adapter(TikTokLiveAdapter("shoptra", client_factory=factory))
    await task
    assert statuses[-1][0] == status and needle in statuses[-1][1]
    assert ProviderStatus.CONNECTED not in [s for s, _ in statuses]  # never a fake "connected"


async def test_rate_limit_is_retryable():
    rl = tterr.SignatureRateLimitError("limit", "Retry in %s seconds",
                                       response=httpx.Response(429, headers={"RateLimit-Remaining": "30", "RateLimit-Reset": "30"},
                                                              request=httpx.Request("GET", "https://x")))
    factory, _ = make(fail=rl)
    task, statuses, _ = await run_adapter(TikTokLiveAdapter("shoptra", client_factory=factory))
    with pytest.raises(ConnectionError, match="giới hạn"):
        await task


async def test_connected_events_flow_capabilities_and_live_end():
    factory, holder = make()
    adapter = TikTokLiveAdapter("shoptra", sign_api_key="sk-euler-123", client_factory=factory)
    task, statuses, raws = await run_adapter(adapter)
    client = holder["client"]
    assert client.sign_api_key == "sk-euler-123"
    assert statuses[-1] == (ProviderStatus.CONNECTED, "Phòng 7000001") and adapter.room_id == "7000001"
    assert adapter.capabilities()["comment"] == Capability.UNKNOWN
    await client.emit(comment(1, "trà cà gai leo"))
    await client.emit(LikeEvent(common=CommonMessageData(msg_id=2), user=LAN, count=3))
    assert [r["type"] for r in raws] == ["COMMENT", "LIKE"]
    caps = adapter.capabilities()
    assert caps["comment"] == Capability.AVAILABLE and caps["like"] == Capability.AVAILABLE
    assert caps["gift"] == Capability.UNKNOWN  # not seen ≠ unavailable
    await client.emit(LiveEndEvent())
    await asyncio.wait_for(task, 1)
    assert statuses[-1][0] == ProviderStatus.ENDED and client.disconnected
    assert raws[-1]["type"] == "LIVE_END"


async def test_network_error_is_retryable_with_vietnamese_reason():
    factory, _ = make(fail=httpx.ConnectError("All connection attempts failed"))
    task, _, _ = await run_adapter(TikTokLiveAdapter("shoptra", client_factory=factory))
    with pytest.raises(ConnectionError, match="Không kết nối được tới TikTok"):
        await task


async def test_websocket_drop_raises_for_reconnect():
    factory, holder = make()
    task, statuses, _ = await run_adapter(TikTokLiveAdapter("shoptra", client_factory=factory))
    holder["client"].drop(OSError("network down"))
    with pytest.raises(ConnectionError, match="Mất kết nối"):
        await asyncio.wait_for(task, 1)


async def test_missing_library_reports_unsupported(monkeypatch):
    adapter = TikTokLiveAdapter("shoptra")

    def boom():
        raise ImportError("no TikTokLive")
    monkeypatch.setattr(adapter, "_error_classes", boom)
    task, statuses, _ = await run_adapter(adapter)
    await task
    assert statuses[-1][0] == ProviderStatus.UNSUPPORTED and "pip install" in statuses[-1][1]


# ---------------------------------------------------------------- short links (NFR-05)
def mock_client(routes: dict[str, tuple[int, str | None]]):
    seen = []

    def handler(req: httpx.Request):
        seen.append(str(req.url))
        code, loc = routes.get(str(req.url), (404, None))
        return httpx.Response(code, headers={"location": loc} if loc else {})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False), seen


async def allow(_h):
    return True


async def test_short_link_resolves_to_live_url():
    client, seen = mock_client({"https://vm.tiktok.com/ZSabc/": (301, "https://www.tiktok.com/@shoptra/live?_r=1&lang=vi")})
    parsed = await resolve_short_link("https://vm.tiktok.com/ZSabc/", client=client, host_check=allow)
    assert parsed.unique_id == "shoptra" and parsed.url == "https://www.tiktok.com/@shoptra/live"
    assert seen == ["https://vm.tiktok.com/ZSabc/"]  # the final tiktok.com page itself is never fetched


@pytest.mark.parametrize("routes,code", [
    ({"https://vm.tiktok.com/a/": (302, "https://evil.example/@x/live")}, "redirect_host"),
    ({"https://vm.tiktok.com/a/": (302, "http://www.tiktok.com/@x/live")}, "redirect_host"),
    ({"https://vm.tiktok.com/a/": (200, None)}, "short_link_dead"),
    ({"https://vm.tiktok.com/a/": (302, "https://vt.tiktok.com/b/"), "https://vt.tiktok.com/b/": (302, "https://vm.tiktok.com/a/")}, "too_many_redirects"),
])
async def test_short_link_guards(routes, code):
    client, _ = mock_client(routes)
    with pytest.raises(InvalidLiveUrl) as e:
        await resolve_short_link("https://vm.tiktok.com/a/", client=client, host_check=allow)
    assert e.value.code == code


async def test_short_link_refuses_private_addresses():
    async def private(_h):
        return False
    client, seen = mock_client({})
    with pytest.raises(InvalidLiveUrl):
        await resolve_short_link("https://vm.tiktok.com/a/", client=client, host_check=private)
    assert seen == []  # no request made at all


# ---------------------------------------------------------------- through the real app
def _wait(c, pred, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        st = c.get("/api/v1/live/status").json()
        if pred(st):
            return st
        time.sleep(0.02)
    return st


def test_api_connect_requires_policy_ack(admin_client):
    r = admin_client.post("/api/v1/live/connect", json={"url": "https://www.tiktok.com/@shoptra/live"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "policy_ack_required"


def test_t01_offline_streamer_via_api(admin_client):
    factory, _ = make(fail=tterr.UserOfflineError())
    admin_client.app.state.container.tiktok_client_factory = factory
    r = admin_client.post("/api/v1/live/connect", json={"url": "https://www.tiktok.com/@shoptra/live", "policy_ack": True})
    assert r.status_code == 200
    st = _wait(admin_client, lambda s: s["status"] not in ("Đang kiểm tra", "Đang kết nối"))
    assert st["status"] == "Không phát LIVE" and "không phát LIVE" in st["detail"]


def test_live_comment_drives_a_chibi_end_to_end(admin_client):
    """A real TikTokLive CommentEvent goes adapter → normalizer → router → action queue."""
    c = admin_client
    factory, holder = make()
    c.app.state.container.tiktok_client_factory = factory
    c.post("/api/v1/live/connect", json={"url": "https://www.tiktok.com/@shoptra/live", "policy_ack": True})
    st = _wait(c, lambda s: s["status"] == "Đã kết nối")
    assert st["provider"] == "tiktok_unofficial" and st["is_demo"] is False and st["room_id"] == "7000001"
    container = c.app.state.container
    client = holder["client"]
    c.portal.call(client.emit, comment(5001, "cho mình xem trà cà gai leo nhé"))  # runs on the app's loop
    end = time.time() + 2
    while time.time() < end and not container.actions.commands:
        time.sleep(0.02)
    cmd = next(iter(container.actions.commands.values()))
    assert cmd.product_id == "TRA_CA_GAI_LEO" and cmd.shelf_code == "KE_02"
    av = container.avatars.get(cmd.avatar_id)
    assert av.nickname == "Lan Anh" and av.is_demo is False
    # demo injection is refused while a real LIVE is connected
    r = c.post("/api/v1/demo/events", json={"raw": "@x: trà"})
    assert r.status_code == 409
    assert c.post("/api/v1/live/disconnect").json()["status"] == "Chưa kết nối" and client.disconnected


def test_sign_key_is_stored_encrypted_and_masked(admin_client):
    c = admin_client
    r = c.patch("/api/v1/settings/live", json={"sign_api_key": "euler_live_abcdef123456"})
    assert r.status_code == 200 and r.json()["sign_api_key"] == "eul…3456"
    assert "abcdef" not in c.get("/api/v1/settings/live").text
    from app.models import Setting
    with c.app.state.container.db.session() as s:
        assert "abcdef" not in s.get(Setting, "tiktok_sign_api_key").encrypted_value
    factory, holder = make(fail=tterr.UserOfflineError())
    c.app.state.container.tiktok_client_factory = factory
    c.post("/api/v1/live/connect", json={"url": "https://www.tiktok.com/@shoptra/live", "policy_ack": True})
    _wait(c, lambda s: s["status"] == "Không phát LIVE")
    assert holder["client"].sign_api_key == "euler_live_abcdef123456"


def test_live_end_and_viewer_count_make_chibis_leave(admin_client):
    c = admin_client
    factory, holder = make()
    c.app.state.container.tiktok_client_factory = factory
    c.post("/api/v1/live/connect", json={"url": "https://www.tiktok.com/@shoptra/live", "policy_ack": True})
    _wait(c, lambda s: s["status"] == "Đã kết nối")
    container, client = c.app.state.container, holder["client"]
    for i, name in enumerate(["an", "binh", "chi"]):
        c.portal.call(client.emit, comment(100 + i, "chào shop", user=User(id=900 + i, nickname=name, display_id=name)))
    end = time.time() + 2
    while time.time() < end and len(container.avatars.visible()) < 3:
        time.sleep(0.02)
    assert len(container.avatars.visible()) == 3
    c.portal.call(client.emit, RoomUserSeqEvent(total=1))  # TikTok: only 1 person watching now
    end = time.time() + 2
    while time.time() < end and len(container.avatars.visible()) > 1:
        time.sleep(0.05)
    assert len(container.avatars.visible()) == 1
    c.portal.call(client.emit, LiveEndEvent())
    st = _wait(c, lambda s: s["status"] == "Đã kết thúc")
    assert st["status"] == "Đã kết thúc" and container.avatars.visible() == []
