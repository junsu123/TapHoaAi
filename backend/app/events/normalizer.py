"""Raw provider dict -> LiveEvent. Providers emit plain dicts so that third-party
library types never leak into domain code."""

from __future__ import annotations

import hashlib
import time
from datetime import UTC, datetime
from typing import Any

from app.events.schema import EventType, EventUser, LiveEvent
from app.text_norm import clean_display_text

MAX_NICKNAME = 64
MAX_ID = 128


class NormalizationError(ValueError):
    pass


def _clip(value: Any, n: int) -> str | None:
    if value is None:
        return None
    s = clean_display_text(str(value), n)
    return s or None


def fingerprint(session_id: str, etype: str, user_key: str | None, payload: dict, bucket_s: int) -> str:
    """Approximate identity for providers without event ids (dedupe within a time bucket)."""
    basis = f"{session_id}|{etype}|{user_key}|{sorted(payload.items())}|{bucket_s}"
    return "fp_" + hashlib.sha256(basis.encode()).hexdigest()[:24]


def normalize(raw: dict[str, Any], *, session_id: str, provider: str, simulated: bool = False) -> LiveEvent:
    try:
        etype = EventType(str(raw.get("type", "")).upper())
    except ValueError as exc:
        raise NormalizationError(f"unknown event type: {raw.get('type')!r}") from exc

    user_raw = raw.get("user") or {}
    user = None
    if user_raw:
        user = EventUser(
            platform_user_id=_clip(user_raw.get("platform_user_id"), MAX_ID),
            unique_id=_clip(user_raw.get("unique_id"), MAX_ID),
            nickname=_clip(user_raw.get("nickname"), MAX_NICKNAME),
        )
        if not (user.platform_user_id or user.unique_id or user.nickname):
            user = None

    payload: dict[str, Any] = {}
    p = raw.get("payload") or {}
    if etype == EventType.COMMENT:
        text = clean_display_text(str(p.get("text", "")))
        if not text:
            raise NormalizationError("empty comment")
        payload["text"] = text
    elif etype == EventType.GIFT:
        payload = {
            "gift_id": _clip(p.get("gift_id"), 64),
            "gift_name": _clip(p.get("gift_name"), 64),
            "repeat_count": max(1, int(p.get("repeat_count", 1) or 1)),
            "repeat_end": bool(p.get("repeat_end", True)),
            "streakable": bool(p.get("streakable", False)),
            "group_id": _clip(p.get("group_id"), 64),
        }
    elif etype == EventType.LIKE:
        payload = {"count": max(1, int(p.get("count", 1) or 1))}
    elif etype == EventType.VIEWER_COUNT:
        payload = {"count": max(0, int(p.get("count", 0) or 0))}

    observed = raw.get("observed_at")
    if isinstance(observed, datetime):
        observed_at = observed.astimezone(UTC)
    elif isinstance(observed, (int, float)):
        observed_at = datetime.fromtimestamp(observed, UTC)
    else:
        observed_at = datetime.now(UTC)

    event_id = _clip(raw.get("event_id"), MAX_ID)
    dedup_mode = "exact"
    if not event_id:
        dedup_mode = "approximate"
        event_id = fingerprint(
            session_id, etype.value, user.identity_key if user else None, payload,
            int(observed_at.timestamp()) // 2,
        )

    return LiveEvent(
        event_id=event_id,
        provider=provider,
        session_id=session_id,
        type=etype,
        observed_at=observed_at,
        user=user,
        payload=payload,
        capability="simulated" if simulated else "observed",
        dedup_mode=dedup_mode,
        received_monotonic=raw.get("_received_monotonic") or time.monotonic(),
    )
