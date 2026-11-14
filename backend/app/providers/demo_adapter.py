"""DemoProvider: simulated events entered from the dashboard. Uses exactly the same raw
dict contract as the live adapter so the whole pipeline is exercised (LIVE-07)."""

from __future__ import annotations

import itertools
import random
import re
import secrets
import time
from typing import Any

from app.providers.live_provider import Capability, LiveEventProvider, ProviderStatus

_SHORTHAND = re.compile(r"^@(?P<user>[A-Za-z0-9_.]{1,32})\s*:\s*(?P<text>.+)$", re.DOTALL)

DEMO_NAMES = [
    "Lan Anh", "Minh Tú", "Bảo Ngọc", "Quốc Huy", "Thu Trang", "Hoàng Nam", "Mai Chi",
    "Gia Bảo", "Khánh Linh", "Đức Anh", "Phương Thảo", "Tuấn Kiệt", "Ngọc Hân", "Thanh Tâm",
]


class DemoProvider(LiveEventProvider):
    name = "demo"

    def __init__(self) -> None:
        super().__init__()
        self._counter = itertools.count(1)
        # unique per Demo session: ids must never repeat across sessions (React keys, the
        # conversation log and the assistant all key on event_id)
        self._run = secrets.token_hex(3)
        self.room_id = "demo_room"

    async def start(self) -> None:
        await self._set_status(ProviderStatus.CONNECTED, "Chế độ Demo — sự kiện mô phỏng")

    async def stop(self) -> None:
        await self._set_status(ProviderStatus.DISCONNECTED)

    def capabilities(self) -> dict[str, Capability]:
        return {k: Capability.AVAILABLE for k in ("comment", "join", "like", "follow", "gift", "viewer_count")}

    @staticmethod
    def demo_user(unique_id: str, nickname: str | None = None) -> dict[str, str]:
        uid = unique_id.lstrip("@")
        return {"platform_user_id": f"demo_{uid.lower()}", "unique_id": uid, "nickname": nickname or uid}

    def next_event_id(self) -> str:
        return f"demo_{self._run}_{next(self._counter):06d}"

    async def inject(self, spec: dict[str, Any]) -> list[str]:
        """Accepts {"type": "COMMENT", "unique_id", "nickname", "text"} or the shorthand
        {"type": "COMMENT", "raw": "@lananh88: trà cà gai leo"}. Returns event ids."""
        if self.status != ProviderStatus.CONNECTED:
            raise RuntimeError("Demo provider is not running")
        etype = str(spec.get("type", "COMMENT")).upper()

        if etype == "SPAWN_RANDOM":
            ids = []
            count = max(1, min(int(spec.get("count", 1)), 100))
            rng = random.Random(spec.get("seed"))
            for _ in range(count):
                n = next(self._counter)
                name = rng.choice(DEMO_NAMES)
                user = self.demo_user(f"khach{n:04d}", f"{name} {n}")
                ids.append(await self._push("JOIN", user, {}))
            return ids

        text = spec.get("text")
        unique_id = spec.get("unique_id")
        nickname = spec.get("nickname")
        raw = spec.get("raw")
        if raw:
            m = _SHORTHAND.match(str(raw).strip())
            if not m:
                raise ValueError("Định dạng phải là @tên: nội dung")
            unique_id, text = m.group("user"), m.group("text")
        if not unique_id:
            raise ValueError("Thiếu tên người xem (unique_id)")
        user = self.demo_user(str(unique_id), nickname)

        payload: dict[str, Any] = {}
        if etype == "COMMENT":
            if not text:
                raise ValueError("Thiếu nội dung bình luận")
            payload = {"text": str(text)}
        elif etype == "GIFT":
            payload = {k: spec[k] for k in ("gift_id", "gift_name", "repeat_count", "repeat_end", "streakable", "group_id") if k in spec}
        elif etype == "LIKE":
            payload = {"count": spec.get("count", 1)}
        return [await self._push(etype, user, payload, spec.get("event_id"))]

    async def _push(self, etype: str, user: dict, payload: dict, event_id: str | None = None) -> str:
        eid = event_id or self.next_event_id()
        await self._emit({
            "event_id": eid, "type": etype, "user": user, "payload": payload,
            "_received_monotonic": time.monotonic(),
        })
        return eid
