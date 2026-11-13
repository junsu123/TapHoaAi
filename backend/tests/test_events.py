import asyncio

import pytest

from app.events.bus import EventBus
from app.events.deduper import Deduper, GiftStreakTracker
from app.events.normalizer import NormalizationError, normalize
from app.events.schema import EventType


def raw_comment(eid="e1", text="trà cà gai leo", uid="uid_1"):
    return {"event_id": eid, "type": "COMMENT",
            "user": {"platform_user_id": uid, "unique_id": "lananh88", "nickname": "Lan Anh"},
            "payload": {"text": text}}


def test_normalize_comment_matches_contract():
    ev = normalize(raw_comment(), session_id="live_abc", provider="demo", simulated=True)
    d = ev.model_dump(mode="json")
    assert d["schema_version"] == 1 and d["type"] == "COMMENT"
    assert d["user"] == {"platform_user_id": "uid_1", "unique_id": "lananh88", "nickname": "Lan Anh"}
    assert d["payload"] == {"text": "trà cà gai leo"}
    assert d["capability"] == "simulated" and d["dedup_mode"] == "exact"
    assert ev.user.identity_key == "pid:uid_1"


def test_identity_falls_back_to_unique_id_never_nickname():
    r = raw_comment()
    r["user"] = {"unique_id": "LanAnh88", "nickname": "Lan Anh"}
    assert normalize(r, session_id="s", provider="p").user.identity_key == "uid:lananh88"
    r["user"] = {"nickname": "Lan Anh"}
    assert normalize(r, session_id="s", provider="p").user.identity_key is None


def test_missing_event_id_uses_labelled_fingerprint():
    r = raw_comment(eid=None)
    ev = normalize(r, session_id="s", provider="p")
    assert ev.dedup_mode == "approximate" and ev.event_id.startswith("fp_")


def test_empty_or_unknown_rejected():
    with pytest.raises(NormalizationError):
        normalize(raw_comment(text="   ​ "), session_id="s", provider="p")
    with pytest.raises(NormalizationError):
        normalize({"type": "HACK"}, session_id="s", provider="p")


def test_html_in_comment_is_kept_as_plain_text():
    ev = normalize(raw_comment(text="<img src=x onerror=alert(1)>"), session_id="s", provider="p")
    assert ev.payload["text"] == "<img src=x onerror=alert(1)>"  # rendered as text, never HTML


def test_deduper_drops_replayed_ids():
    d = Deduper()
    ev = normalize(raw_comment(), session_id="s", provider="p")
    assert not d.is_duplicate(ev)
    assert d.is_duplicate(normalize(raw_comment(), session_id="s", provider="p"))
    assert not d.is_duplicate(normalize(raw_comment(eid="e2"), session_id="s", provider="p"))


def gift(eid, count, end, group="g1"):
    return normalize({"event_id": eid, "type": "GIFT", "user": {"platform_user_id": "u1"},
                      "payload": {"gift_id": "rose", "repeat_count": count, "repeat_end": end,
                                  "streakable": True, "group_id": group}}, session_id="s", provider="p")


def test_gift_streak_counted_once_at_end():
    """T08: repeated streak updates must not inflate the total."""
    t = GiftStreakTracker()
    assert [t.settle(gift(f"g{i}", i, False)) for i in range(1, 6)] == [0] * 5
    assert t.settle(gift("g6", 5, True)) == 5
    assert t.settle(gift("g7", 5, True)) == 0  # duplicated final message
    assert t.total_gifts == 5
    assert t.settle(gift("g8", 2, True, group="g2")) == 2
    assert t.total_gifts == 7


async def test_bus_drops_likes_not_comments_when_full():
    bus = EventBus(max_size=1)
    c1 = normalize(raw_comment("c1"), session_id="s", provider="p")
    like = normalize({"event_id": "l1", "type": "LIKE", "payload": {"count": 3}}, session_id="s", provider="p")
    assert await bus.publish(c1)
    assert not await bus.publish(like)
    assert bus.dropped_low_priority == 1
    c2 = normalize(raw_comment("c2"), session_id="s", provider="p")
    task = asyncio.create_task(bus.publish(c2))  # waits (back-pressure), never dropped
    await asyncio.sleep(0.01)
    assert not task.done()
    assert (await bus.get()).event_id == "c1"
    assert await task
    assert (await bus.get()).type == EventType.COMMENT
