"""Provider interface. Domain services only see this interface and plain dict events."""

from __future__ import annotations

import abc
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import Any

RawEventCallback = Callable[[dict[str, Any]], Awaitable[None]]
StatusCallback = Callable[["ProviderStatus", str | None], Awaitable[None]]


class ProviderStatus(StrEnum):
    DISCONNECTED = "Chưa kết nối"
    CHECKING = "Đang kiểm tra"
    CONNECTING = "Đang kết nối"
    CONNECTED = "Đã kết nối"
    LOST = "Mất kết nối"
    ENDED = "Đã kết thúc"
    OFFLINE = "Không phát LIVE"
    UNSUPPORTED = "Không hỗ trợ"


class Capability(StrEnum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
    DEGRADED = "degraded"
    UNKNOWN = "unknown"


class LiveEventProvider(abc.ABC):
    name: str = "base"

    def __init__(self) -> None:
        self.on_raw_event: RawEventCallback | None = None
        self.on_status: StatusCallback | None = None
        self.status: ProviderStatus = ProviderStatus.DISCONNECTED
        self.room_id: str | None = None

    @abc.abstractmethod
    async def start(self) -> None: ...

    @abc.abstractmethod
    async def stop(self) -> None: ...

    @abc.abstractmethod
    def capabilities(self) -> dict[str, Capability]: ...

    async def _set_status(self, status: ProviderStatus, detail: str | None = None) -> None:
        self.status = status
        if self.on_status:
            await self.on_status(status, detail)

    async def _emit(self, raw: dict[str, Any]) -> None:
        if self.on_raw_event:
            await self.on_raw_event(raw)
