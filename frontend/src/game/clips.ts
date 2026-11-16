// Animation clips (spec V3 §7, T12). Every FSM state plays a named clip. The procedural Chibi
// has all of them; a rigged model (GLB) may not. A missing clip falls back to the nearest one in
// meaning (dance → cheer → wave → idle), a warning is logged once per clip, and nothing crashes.

import type { AnimState } from "./AnimationFSM";

/** Clips the spec requires every Chibi rig to offer (or to fall back from). */
export const REQUIRED_CLIPS = ["idle", "walk", "turn", "wave", "look", "reach", "hold", "present", "put_back", "sit", "stand_up", "dance", "cheer", "leave"] as const;

/** The clip each animation state plays. */
export const CLIP_OF: Record<AnimState, string> = {
  idle: "idle",
  walk: "walk",
  wave: "wave",
  inspect: "look",
  pickup: "reach",
  hold: "hold",
  show: "present",
  return: "put_back",
  wait: "idle",
  checkout: "idle",
  exit: "leave",
  dance: "dance",
  celebrate: "cheer",
  sit: "sit",
  look: "look",
  stretch: "stretch",
  nod: "nod",
  browse: "look",
  lookup: "look",
  pose: "pose",
  spin: "spin",
  surprise: "surprise",
  think: "think",
  point: "point",
  cheer: "cheer",
  yawn: "yawn",
  standup: "stand_up",
};

/** Nearest clip in meaning, tried in order until one exists (always ends at idle). */
export const CLIP_FALLBACK: Record<string, string> = {
  dance: "cheer",
  cheer: "wave",
  pose: "cheer",
  spin: "dance",
  surprise: "cheer",
  wave: "idle",
  think: "look",
  nod: "look",
  look: "idle",
  stretch: "idle",
  yawn: "stretch",
  point: "present",
  present: "hold",
  hold: "idle",
  reach: "hold",
  put_back: "reach",
  stand_up: "walk",
  leave: "walk",
  turn: "walk",
  walk: "idle",
  sit: "idle",
};

/** Which state draws a given clip (used to pick the fallback pose). */
const STATE_OF_CLIP: Record<string, AnimState> = {
  idle: "idle",
  walk: "walk",
  wave: "wave",
  look: "look",
  reach: "pickup",
  hold: "hold",
  present: "show",
  put_back: "return",
  leave: "walk",
  dance: "dance",
  cheer: "cheer",
  sit: "sit",
  stretch: "stretch",
  nod: "nod",
  pose: "pose",
  spin: "spin",
  surprise: "surprise",
  think: "think",
  point: "point",
  yawn: "yawn",
  stand_up: "standup",
  turn: "walk",
};

/** Clips the built-in procedural Chibi can play: all of them. */
export const PROCEDURAL_CLIPS: string[] = [...new Set([...REQUIRED_CLIPS, ...Object.values(CLIP_OF)])];

export class ClipLibrary {
  private available: Set<string>;
  private cache = new Map<AnimState, AnimState>();
  private warned = new Set<string>();
  /** one entry per missing clip that was asked for: "dance → cheer" */
  readonly warnings: string[] = [];

  constructor(available: Iterable<string> = PROCEDURAL_CLIPS, private warn: (msg: string) => void = (m) => console.warn(m)) {
    this.available = new Set(available);
  }

  has(clip: string): boolean {
    return this.available.has(clip);
  }

  missing(): string[] {
    return REQUIRED_CLIPS.filter((c) => !this.available.has(c));
  }

  /** The state whose pose is drawn for `state`: itself, or the nearest one whose clip exists. */
  resolve(state: AnimState): AnimState {
    const hit = this.cache.get(state);
    if (hit) return hit;
    const want = CLIP_OF[state] ?? "idle";
    let clip = want;
    const seen = new Set<string>();
    while (!this.available.has(clip) && clip !== "idle" && !seen.has(clip)) {
      seen.add(clip);
      clip = CLIP_FALLBACK[clip] ?? "idle";
    }
    // a rig without even "idle" still stands still in the idle pose: never crash
    const found = this.available.has(clip);
    const out: AnimState = clip === want && found ? state : found ? (STATE_OF_CLIP[clip] ?? "idle") : "idle";
    if ((clip !== want || !found) && !this.warned.has(want)) {
      this.warned.add(want);
      const msg = `[chibi] thiếu clip "${want}" → dùng "${this.available.has(clip) ? clip : "idle"}"`;
      this.warnings.push(`${want} → ${this.available.has(clip) ? clip : "idle"}`);
      this.warn(msg);
    }
    this.cache.set(state, out);
    return out;
  }
}
