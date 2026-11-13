"""Store map geometry and validation for the shelf editor (GAME-02, PRD-02).

Shelves rotate in 90° steps. A shelf's FRONT faces direction (sin rot, cos rot) — rot=0
faces +z (towards the camera/door). Stand positions are in front of it, wait positions
beside them. Every edit is validated before saving: inside the store, no overlap (with
an aisle gap), door and counter kept clear, and every stand position reachable on foot
from the door (same grid rules as the game's A*)."""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

STORE_W, STORE_D = 12.0, 16.0
COUNTER = {"x": 0.0, "z": -6.6, "w": 3.2, "d": 0.8}
DOOR = {"x": 0.0, "z": 7.4}
DOOR_ZONE = (-1.6, 1.6, 6.0, 8.0)  # minX, maxX, minZ, maxZ — must stay empty
SHELF_W, SHELF_D, SHELF_H = 2.4, 0.6, 1.6
SLOT_XS = (-0.7, 0.0, 0.7)
STAND_OFFSET = 0.55  # from the shelf front to the avatar's stand point
MIN_GAP = 0.9  # clear aisle between two shelves' footprints
AGENT_R = 0.3
WALL_MARGIN = 0.35
CELL = 0.25
ROTATIONS = (0, 90, 180, 270)


@dataclass(frozen=True)
class Rect:
    min_x: float
    max_x: float
    min_z: float
    max_z: float

    def inflate(self, r: float) -> Rect:
        return Rect(self.min_x - r, self.max_x + r, self.min_z - r, self.max_z + r)

    def overlaps(self, o: Rect) -> bool:
        return self.min_x < o.max_x and o.min_x < self.max_x and self.min_z < o.max_z and o.min_z < self.max_z

    def contains(self, x: float, z: float) -> bool:
        return self.min_x <= x <= self.max_x and self.min_z <= z <= self.max_z


def rot_rad(deg: int) -> float:
    return math.radians(deg % 360)


def rot_deg(rad: float) -> int:
    return int(round(math.degrees(rad))) % 360


def _r(v: float) -> float:
    return round(v, 3)


def shelf_geometry(x: float, z: float, rot_degrees: int = 0, w: float = SHELF_W, d: float = SHELF_D) -> dict:
    rot = rot_rad(rot_degrees)
    fx, fz = math.sin(rot), math.cos(rot)  # front direction
    rx, rz = math.cos(rot), -math.sin(rot)  # right direction (matches the client's slotWorld)
    front = d / 2 + STAND_OFFSET
    stands = [{"x": _r(x + fx * front + rx * dx), "z": _r(z + fz * front + rz * dx)} for dx in SLOT_XS]
    side = w / 2 + 0.55
    waits = [{"x": _r(x + fx * front + rx * s * side), "z": _r(z + fz * front + rz * s * side)} for s in (-1, 1)]
    return {
        "transform": {"x": _r(x), "z": _r(z), "rot": rot, "w": w, "d": d, "h": SHELF_H},
        "stand_positions": stands,
        "wait_positions": waits,
    }


def footprint(t: dict) -> Rect:
    quarter = rot_deg(t["rot"]) in (90, 270)
    hw = (t["d"] if quarter else t["w"]) / 2
    hd = (t["w"] if quarter else t["d"]) / 2
    return Rect(t["x"] - hw, t["x"] + hw, t["z"] - hd, t["z"] + hd)


def counter_rect() -> Rect:
    c = COUNTER
    return Rect(c["x"] - c["w"] / 2, c["x"] + c["w"] / 2, c["z"] - c["d"] / 2, c["z"] + c["d"] / 2)


class _Grid:
    def __init__(self, obstacles: list[Rect]):
        self.cols = int(round(STORE_W / CELL))
        self.rows = int(round(STORE_D / CELL))
        self.min_x, self.min_z = -STORE_W / 2, -STORE_D / 2
        infl = [o.inflate(AGENT_R) for o in obstacles]
        self.free = [[False] * self.cols for _ in range(self.rows)]
        for r in range(self.rows):
            for c in range(self.cols):
                x, z = self.center(c, r)
                wall = (x < self.min_x + WALL_MARGIN or x > -self.min_x - WALL_MARGIN
                        or z < self.min_z + WALL_MARGIN or z > -self.min_z - WALL_MARGIN)
                self.free[r][c] = not wall and not any(o.contains(x, z) for o in infl)

    def center(self, c: int, r: int) -> tuple[float, float]:
        return self.min_x + (c + 0.5) * CELL, self.min_z + (r + 0.5) * CELL

    def cell(self, x: float, z: float) -> tuple[int, int]:
        c = min(self.cols - 1, max(0, int((x - self.min_x) // CELL)))
        r = min(self.rows - 1, max(0, int((z - self.min_z) // CELL)))
        return c, r

    def is_free(self, x: float, z: float) -> bool:
        c, r = self.cell(x, z)
        return self.free[r][c]

    def reachable_from(self, x: float, z: float) -> set[tuple[int, int]]:
        start = self.cell(x, z)
        if not self.free[start[1]][start[0]]:
            return set()
        seen = {start}
        q = deque([start])
        while q:
            c, r = q.popleft()
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (c + dc, r + dr)
                if 0 <= n[0] < self.cols and 0 <= n[1] < self.rows and n not in seen and self.free[n[1]][n[0]]:
                    seen.add(n)
                    q.append(n)
        return seen


def validate_layout(shelves: list[dict]) -> list[str]:
    """`shelves`: [{"code", "name", "transform", "stand_positions", "wait_positions"}].
    Returns human-readable Vietnamese errors (empty list = valid)."""
    errors: list[str] = []
    rects = {s["code"]: footprint(s["transform"]) for s in shelves}
    store = Rect(-STORE_W / 2 + WALL_MARGIN, STORE_W / 2 - WALL_MARGIN, -STORE_D / 2 + WALL_MARGIN, STORE_D / 2 - WALL_MARGIN)
    door = Rect(*DOOR_ZONE)
    counter = counter_rect()
    codes = list(rects)
    for i, code in enumerate(codes):
        r = rects[code]
        name = next(s["name"] for s in shelves if s["code"] == code)
        if not (store.contains(r.min_x, r.min_z) and store.contains(r.max_x, r.max_z)):
            errors.append(f"{name} nằm ngoài cửa hàng hoặc sát tường.")
        if r.overlaps(door):
            errors.append(f"{name} chắn lối cửa ra vào.")
        if r.inflate(MIN_GAP / 2).overlaps(counter.inflate(MIN_GAP / 2)):
            errors.append(f"{name} quá gần quầy thu ngân (cần lối đi ≥ {MIN_GAP} m).")
        for other in codes[i + 1:]:
            if r.inflate(MIN_GAP / 2).overlaps(rects[other].inflate(MIN_GAP / 2)):
                other_name = next(s["name"] for s in shelves if s["code"] == other)
                errors.append(f"{name} chồng lên hoặc quá sát {other_name} (cần lối đi ≥ {MIN_GAP} m).")
    if errors:
        return errors
    grid = _Grid(list(rects.values()) + [counter])
    reach = grid.reachable_from(DOOR["x"], DOOR["z"])
    for s in shelves:
        for kind, pts in (("điểm đứng", s["stand_positions"]), ("điểm chờ", s["wait_positions"])):
            for p in pts:
                if not grid.is_free(p["x"], p["z"]):
                    errors.append(f"{s['name']}: {kind} bị chắn hoặc nằm sát tường.")
                    break
                if kind == "điểm đứng" and grid.cell(p["x"], p["z"]) not in reach:
                    errors.append(f"{s['name']}: khách không đi từ cửa tới được {kind}.")
                    break
    return errors
