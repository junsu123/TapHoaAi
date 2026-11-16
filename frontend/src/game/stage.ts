// The dance stage at the front of the shop (pure geometry, no three.js). Viewers who comment
// "nhảy" / "lên sân khấu" dance on it one after another (the server keeps the line).

import type { Point2, StoreLayout } from "../types/protocol";

export interface StageSpot {
  center: Point2;
  w: number; // along x
  d: number; // along z
  height: number;
  side: 1 | -1; // +1 right of the door, -1 left
  top: Point2; // where the dancer stands
  approach: Point2; // foot of the steps (walkable)
  stepsX: number; // x of the steps (inner side)
  obstacle: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function stageSpot(layout: StoreLayout, side: "right" | "left" = "right"): StageSpot {
  const W = layout.store.width;
  const D = layout.store.depth;
  const s: 1 | -1 = side === "left" ? -1 : 1;
  const w = 2.4;
  const d = 1.5;
  const center = { x: s * Math.max(1.3 + w / 2, W * 0.22), z: D / 2 - 1.9 };
  const inner = center.x - s * (w / 2);
  return {
    center,
    w,
    d,
    height: 0.28,
    side: s,
    top: { x: center.x, z: center.z + 0.1 },
    approach: { x: inner - s * 0.6, z: center.z + 0.1 },
    stepsX: inner - s * 0.18,
    obstacle: { minX: center.x - w / 2 - 0.05, maxX: center.x + w / 2 + 0.05, minZ: center.z - d / 2 - 0.05, maxZ: center.z + d / 2 + 0.05 },
  };
}

/** The dance routine on stage: a new move every few seconds (all Chibis know it). */
export const STAGE_MOVES = ["dance", "spin", "pose", "dance", "cheer", "spin", "dance", "pose"] as const;
export const STAGE_MOVE_SECONDS = 2.4;
