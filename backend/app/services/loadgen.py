"""Demo load generator: a busy LIVE in a box — hundreds of comments, likes, joins and gifts per
second from thousands of different (clearly fake, demo_) viewers, sent through the normal Demo
provider path so the whole pipeline is exercised. Used by the "Thử lượt xem cao" button and the
load-test script. Never runs on a real LIVE.
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from typing import Any

# a busy LIVE is mostly chatter; product names and questions are the minority
CHATTER = [
    "chào shop", "chào cả nhà", "đẹp quá", "live vui ghê", "mình mới vào", "hay quá shop", "❤️❤️❤️", "haha",
    "tuyệt vời", "ok shop", "shop bán lâu chưa", "hôm nay có khuyến mãi gì không", "nhảy đi", "tạo dáng đi",
    "đi dạo", "ngồi nghỉ chút", "hello", "xin chào", "chị ơi", "quá xịn", "ủng hộ shop", "thả tim nè",
    "trời mưa quá", "mọi người ăn cơm chưa", "nhạc hay ghê", "về thôi", "tạm biệt shop",
]
PRODUCTS = ["trà cà gai leo", "cho mình xem trà cà gai leo", "trà ba kích", "shop ơi trà ba kích còn không", "trà"]
QUESTIONS = ["giá bao nhiêu vậy shop", "trà này uống có tốt không", "ship về hà nội bao lâu", "thành phần có gì vậy",
             "uống buổi tối được không ạ", "mua 2 hộp có giảm không", "trà cà gai leo giá sao shop"]
COMMENT_MIX = ((CHATTER, 0.78), (PRODUCTS, 0.12), (QUESTIONS, 0.10))
GIFTS = [("Hoa hồng", 1), ("Trái tim", 5), ("Cà phê", 10), ("Mũ cao bồi", 99)]
NAMES = ["Lan", "Minh", "Ngọc", "Huy", "Trang", "Nam", "Chi", "Bảo", "Linh", "Đức", "Thảo", "Kiệt", "Hân", "Tâm"]

# share of each event type in a busy LIVE (likes dominate)
DEFAULT_MIX = {"LIKE": 0.45, "COMMENT": 0.30, "JOIN": 0.18, "GIFT": 0.03, "SHARE": 0.02, "FOLLOW": 0.02}


@dataclass
class LoadRun:
    rate: float
    seconds: float
    viewers: int
    started: float = field(default_factory=time.monotonic)
    sent: int = 0
    by_type: dict[str, int] = field(default_factory=dict)
    behind_max_s: float = 0.0  # how far the generator fell behind its schedule (back-pressure)
    done: bool = False
    stopped: bool = False

    def view(self) -> dict[str, Any]:
        elapsed = max(1e-6, (time.monotonic() - self.started) if not self.done else self.seconds)
        return {"rate": self.rate, "seconds": self.seconds, "viewers": self.viewers, "sent": self.sent,
                "achieved_rate": round(self.sent / elapsed, 1), "by_type": dict(self.by_type),
                "behind_max_s": round(self.behind_max_s, 2), "done": self.done, "stopped": self.stopped}


class LoadGenerator:
    def __init__(self) -> None:
        self.run: LoadRun | None = None
        self._task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self, provider, rate: float, seconds: float, viewers: int = 2000, seed: int | None = None,
              on_done=None, product_share: float = 0.12) -> LoadRun:
        """product_share: part of the comments that ask for a product (the rest: 10 % questions,
        the remainder chatter)."""
        self.stop()
        run = LoadRun(rate=rate, seconds=seconds, viewers=viewers)
        self.run = run
        mix = ((CHATTER, max(0.0, 0.9 - product_share)), (PRODUCTS, product_share), (QUESTIONS, 0.10))
        self._task = asyncio.create_task(self._go(provider, run, random.Random(seed), on_done, mix), name="loadgen")
        return run

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            if self.run:
                self.run.stopped = True
                self.run.done = True

    async def _go(self, provider, run: LoadRun, rng: random.Random, on_done, mix=COMMENT_MIX) -> None:
        kinds, weights = zip(*DEFAULT_MIX.items(), strict=True)
        tick = 0.05
        t0 = time.monotonic()
        n = 0
        streak = 0
        try:
            while True:
                now = time.monotonic() - t0
                if now >= run.seconds:
                    break
                due = int(now * run.rate) - n  # events that should have been sent by now
                for _ in range(max(0, due)):
                    kind = rng.choices(kinds, weights)[0]
                    vid = rng.randrange(run.viewers)
                    user = {"platform_user_id": f"demo_load{vid:05d}", "unique_id": f"load{vid:05d}",
                            "nickname": f"{NAMES[vid % len(NAMES)]} {vid}"}
                    payload: dict[str, Any] = {}
                    if kind == "COMMENT":
                        pool = rng.choices([p for p, _ in mix], [w for _, w in mix])[0]
                        payload = {"text": rng.choice(pool)}
                    elif kind == "LIKE":
                        payload = {"count": rng.randint(1, 15)}
                    elif kind == "GIFT":
                        name, diamonds = rng.choice(GIFTS)
                        streak += 1
                        payload = {"gift_id": name, "gift_name": name, "diamonds": diamonds, "repeat_count": 1,
                                   "repeat_end": True, "streakable": False, "group_id": f"g{streak}"}
                    await provider.push_raw(kind, user, payload)
                    n += 1
                    run.sent = n
                    run.by_type[kind] = run.by_type.get(kind, 0) + 1
                behind = (time.monotonic() - t0) - n / run.rate
                run.behind_max_s = max(run.behind_max_s, behind)
                await asyncio.sleep(tick)
        finally:
            run.done = True
            if on_done:
                on_done(run)
