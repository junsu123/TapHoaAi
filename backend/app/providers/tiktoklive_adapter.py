"""TikTok LIVE adapter — milestone M3, NOT implemented in M0/M1.

The interface is fixed so M3 can drop in a TikTokLive-based implementation without
touching domain code. Until then this provider honestly reports UNSUPPORTED and never
claims a connection (LIVE-02). TikTokLive is unofficial and AGPL-licensed: review the
licence and TikTok's terms before shipping it commercially (SPEC Q)."""

from __future__ import annotations

from app.providers.live_provider import Capability, LiveEventProvider, ProviderStatus


class TikTokLiveAdapter(LiveEventProvider):
    name = "tiktok_unofficial"

    def __init__(self, unique_id: str):
        super().__init__()
        self.unique_id = unique_id

    async def start(self) -> None:
        await self._set_status(ProviderStatus.CHECKING)
        await self._set_status(
            ProviderStatus.UNSUPPORTED,
            "Kết nối TikTok LIVE thật chưa được triển khai (mốc M3). Hãy dùng chế độ Demo.",
        )

    async def stop(self) -> None:
        await self._set_status(ProviderStatus.DISCONNECTED)

    def capabilities(self) -> dict[str, Capability]:
        return {k: Capability.UNKNOWN for k in ("comment", "join", "like", "follow", "gift", "viewer_count")}
