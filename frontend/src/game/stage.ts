// The dance stage (pure geometry, no three.js). Viewers who comment "nhảy" / "lên sân khấu"
// dance on it one after another (the server keeps the line).
//
// "center" (default): a round stage in the middle aisle, in the middle of the picture, so every
// viewer sees the dancer. It is placed where it keeps a walkway on both sides and stays clear of
// shelves, the people standing at them, the tea table and the door; if the shop's own layout
// leaves no such place, it goes to the front corner ("right") instead.
// "right" / "left": the square stage at the front, beside the door.

import type { Point2, StoreLayout } from "../types/protocol";

export type StageSide = "center" | "right" | "left";
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

export interface StageSpot {
  shape: "round" | "box";
  center: Point2;
  w: number; // along x
  d: number; // along z
  radius: number; // round stage (box: half the width)
  height: number;
  side: 1 | -1; // box: +1 right of the door, -1 left
  top: Point2; // where the dancer stands
  approach: Point2; // foot of the steps (walkable)
  steps: Point2; // top of the steps (the platform edge)
  stepsX: number; // x of the steps (box stage, kept for older callers)
  obstacle: Rect;
  placed: StageSide; // where it really went
}

const ROUND_R = 0.8; // 1.6 m across: room for one Chibi dancing, a walkway left and right in a 3.6 m aisle
const ROUND_H = 0.32;
const CLEAR = 1.0; // free gap to shelves / tables (2 nav cells after the 0.3 m character radius)

function shelfRects(layout: StoreLayout): Rect[] {
  return layout.shelves.map((s) => {
    const quarter = Math.round(Math.abs(Math.sin(s.transform.rot))) === 1;
    const hw = (quarter ? s.transform.d : s.transform.w) / 2;
    const hd = (quarter ? s.transform.w : s.transform.d) / 2;
    return { minX: s.transform.x - hw, maxX: s.transform.x + hw, minZ: s.transform.z - hd, maxZ: s.transform.z + hd };
  });
}

const grow = (r: Rect, k: number): Rect => ({ minX: r.minX - k, maxX: r.maxX + k, minZ: r.minZ - k, maxZ: r.maxZ + k });
const overlaps = (a: Rect, b: Rect) => a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
const inside = (p: Point2, r: Rect) => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;

/** A free place for the round stage near the middle of the picture, or null. */
export function centerStagePlace(layout: StoreLayout, extra: Rect[] = [], extraClear = 0.6): Point2 | null {
  const W = layout.store.width;
  const D = layout.store.depth;
  const c = layout.store.counter;
  const blocks: Rect[] = [
    ...shelfRects(layout).map((r) => grow(r, CLEAR)),
    grow({ minX: c.x - c.w / 2, maxX: c.x + c.w / 2, minZ: c.z - c.d / 2, maxZ: c.z + c.d / 2 }, CLEAR),
    ...extra.map((r) => grow(r, extraClear)), // the tea table, benches: a walkway is enough
    { minX: layout.store.door.x - 1.8, maxX: layout.store.door.x + 1.8, minZ: D / 2 - 2.6, maxZ: D / 2 }, // door way
  ];
  // where people stand at shelves (and wait beside them) keeps a step of room
  const people = layout.shelves.flatMap((s) => [...s.stand_positions, ...s.wait_positions]);
  const zPref = -D * 0.075; // the middle of the overview picture (where the tea table used to be)
  const zs: number[] = [];
  // only the middle band of the picture: further back or further front it is not "the centre" any more
  for (let z = zPref - 2.5; z <= zPref + 2; z += 0.25) zs.push(+z.toFixed(2));
  zs.sort((a, b) => Math.abs(a - zPref) - Math.abs(b - zPref));
  const xs = [0, 0.25, -0.25, 0.5, -0.5];
  for (const z of zs) {
    for (const dx of xs) {
      const x = layout.store.door.x + dx;
      const me: Rect = { minX: x - ROUND_R, maxX: x + ROUND_R, minZ: z - ROUND_R, maxZ: z + ROUND_R };
      if (me.minX < -W / 2 + 1 || me.maxX > W / 2 - 1) continue;
      if (blocks.some((b) => overlaps(me, b))) continue;
      if (people.some((p) => inside(p, grow(me, 0.3)))) continue;
      return { x, z };
    }
  }
  return null;
}

export function stageSpot(layout: StoreLayout, side: StageSide = "center", extra: Rect[] = []): StageSpot {
  if (side === "center") {
    const at = centerStagePlace(layout, extra);
    if (at) return roundStage(layout, at, extra);
    side = "right";
  }
  const W = layout.store.width;
  const D = layout.store.depth;
  const s: 1 | -1 = side === "left" ? -1 : 1;
  const w = 2.4;
  const d = 1.5;
  const center = { x: s * Math.max(1.3 + w / 2, W * 0.22), z: D / 2 - 1.9 };
  const inner = center.x - s * (w / 2);
  return {
    shape: "box",
    center,
    w,
    d,
    radius: w / 2,
    height: 0.28,
    side: s,
    top: { x: center.x, z: center.z + 0.1 },
    approach: { x: inner - s * 0.6, z: center.z + 0.1 },
    steps: { x: inner - s * 0.18, z: center.z + 0.1 },
    stepsX: inner - s * 0.18,
    obstacle: { minX: center.x - w / 2 - 0.05, maxX: center.x + w / 2 + 0.05, minZ: center.z - d / 2 - 0.05, maxZ: center.z + d / 2 + 0.05 },
    placed: side,
  };
}

/** The round stage; its steps face the door if there is room, else the freer side. */
function roundStage(layout: StoreLayout, at: Point2, extra: Rect[]): StageSpot {
  const r = ROUND_R;
  const blocked = [...shelfRects(layout), ...extra].map((b) => grow(b, 0.35));
  const free = (p: Point2) => !blocked.some((b) => inside(p, b));
  // front (towards the door and the camera), then left / right
  const dirs: Point2[] = [
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 1, z: 0 },
  ];
  const dir = dirs.find((v) => free({ x: at.x + v.x * (r + 0.55), z: at.z + v.z * (r + 0.55) })) ?? dirs[1];
  return {
    shape: "round",
    center: at,
    w: r * 2,
    d: r * 2,
    radius: r,
    height: ROUND_H,
    side: dir.x < 0 ? -1 : 1,
    top: { x: at.x, z: at.z },
    approach: { x: at.x + dir.x * (r + 0.55), z: at.z + dir.z * (r + 0.55) },
    steps: { x: at.x + dir.x * (r - 0.05), z: at.z + dir.z * (r - 0.05) },
    stepsX: at.x + dir.x * (r - 0.05),
    obstacle: { minX: at.x - r - 0.05, maxX: at.x + r + 0.05, minZ: at.z - r - 0.05, maxZ: at.z + r + 0.05 },
    placed: "center",
  };
}

/** The dance routine on stage: a new move every few seconds (all Chibis know it). */
export const STAGE_MOVES = ["dance", "spin", "pose", "dance", "cheer", "spin", "dance", "pose"] as const;
export const STAGE_MOVE_SECONDS = 2.4;
