// Render level of detail for the Chibis (spec V3 §7, §10 — T16). One shared state per page:
// the World updates the camera frustum and the distance thresholds once per frame; every
// ChibiAvatar picks its tier from them.
//
//   full     close to the camera (or in focus): outlines, face details, pose every frame
//   reduced  middle distance: no outlines, pose every frame
//   far      far away: low-poly parts, no small face details, pose every other frame
//   hidden   outside the picture (never the focused Chibi or one carrying a box): no pose work

import * as THREE from "three";

export type LodTier = "full" | "reduced" | "far" | "hidden";

export const LOD = {
  frustum: new THREE.Frustum(),
  near: 12,
  far: 99,
  frame: 0,
  counts: { full: 0, reduced: 0, far: 0, hidden: 0 },
  enabled: true,
};

/**
 * Thresholds from the crowd size and the measured frame rate: a quiet shop draws everyone in
 * full; a crowded one (or a slow PC) thins out the far-away Chibis first — names and the box
 * in a Chibi's hand are never reduced.
 */
export function lodPolicy(avatars: number, fps: number | null): { near: number; far: number; level: 0 | 1 | 2 } {
  let level: 0 | 1 | 2 = avatars > 35 ? 2 : avatars > 20 ? 1 : 0;
  if (fps !== null && fps < 22 && avatars > 8) level = 2;
  else if (fps !== null && fps < 27 && level === 0 && avatars > 8) level = 1;
  if (level === 0) return { near: 12, far: 99, level };
  if (level === 1) return { near: 9, far: 17, level };
  return { near: 6, far: 13, level };
}

export function lodTier(dist: number, inView: boolean, keep: boolean): LodTier {
  if (!LOD.enabled) return "full";
  if (keep) return dist < LOD.near ? "full" : "reduced";
  if (!inView) return "hidden";
  if (dist < LOD.near) return "full";
  return dist < LOD.far ? "reduced" : "far";
}
