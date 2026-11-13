"""Typed event contract shared by every provider (SPEC F1)."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class EventType(StrEnum):
    COMMENT = "COMMENT"
    JOIN = "JOIN"
    LIKE = "LIKE"
    FOLLOW = "FOLLOW"
    GIFT = "GIFT"
    SHARE = "SHARE"
    VIEWER_COUNT = "VIEWER_COUNT"
    LIVE_END = "LIVE_END"


class EventUser(BaseModel):
    platform_user_id: str | None = None
    unique_id: str | None = None
    nickname: str | None = None

    @property
    def identity_key(self) -> str | None:
        """Stable identity: platform id first, unique_id second, never nickname."""
        if self.platform_user_id:
            return f"pid:{self.platform_user_id}"
        if self.unique_id:
            return f"uid:{self.unique_id.lower()}"
        return None


class LiveEvent(BaseModel):
    schema_version: Literal[1] = 1
    event_id: str
    provider: str
    session_id: str
    type: EventType
    observed_at: datetime
    user: EventUser | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    capability: Literal["observed", "simulated"] = "observed"
    dedup_mode: Literal["exact", "approximate"] = "exact"
    # monotonic seconds when the adapter received it (latency metrics, NFR-01)
    received_monotonic: float = 0.0
