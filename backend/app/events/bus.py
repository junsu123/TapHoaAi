"""Bounded event bus. When full, low-value social events (LIKE/JOIN/VIEWER_COUNT) are
dropped first; comments are never dropped — the publisher waits instead."""

from __future__ import annotations

import asyncio

from app.events.schema import EventType, LiveEvent

DROPPABLE = {EventType.LIKE, EventType.JOIN, EventType.VIEWER_COUNT, EventType.SHARE}


class EventBus:
    def __init__(self, max_size: int = 2000):
        self.queue: asyncio.Queue[LiveEvent] = asyncio.Queue(maxsize=max_size)
        self.dropped_low_priority = 0
        self.published = 0

    async def publish(self, ev: LiveEvent) -> bool:
        if self.queue.full() and ev.type in DROPPABLE:
            self.dropped_low_priority += 1
            return False
        await self.queue.put(ev)  # comments/gifts wait for space (back-pressure)
        self.published += 1
        return True

    async def get(self) -> LiveEvent:
        return await self.queue.get()

    def task_done(self) -> None:
        self.queue.task_done()

    @property
    def depth(self) -> int:
        return self.queue.qsize()
