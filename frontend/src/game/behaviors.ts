// Behaviour catalogue and the autonomous scheduler (spec V3 §3.2, §4, §5).
// Pure TypeScript (no three.js) so it can be tested headless.
//
// A Chibi with no command picks its next activity from weighted groups (browse 30, explore 25,
// idle 20, social 10, rest 10, fun 5 — configurable), never the same activity three times in a
// row, respecting per-activity cooldowns, and with fun / crowd movement toned down while the
// camera is on a product. Randomness comes from a per-Chibi seeded generator, so a run is
// reproducible in tests and Chibis are never in sync.

import type { Point2, ShelfLayout, StoreLayout } from "../types/protocol";
import type { AnimState } from "./AnimationFSM";
import type { NavGrid } from "./Navigation";

/** Exactly one top-level state per Chibi (spec §4). */
export type TopState =
  | "SPAWNING"
  | "ENTERING"
  | "IDLE"
  | "NAVIGATING"
  | "BROWSING"
  | "WAITING_SLOT"
  | "PICKING"
  | "HOLDING"
  | "PRESENTING"
  | "RETURNING_ITEM"
  | "SOCIALIZING"
  | "PLAYING"
  | "RESTING"
  | "LEAVING"
  | "DESPAWNED"
  | "ERROR_RECOVERY";

export type Group = "browse" | "explore" | "idle" | "social" | "rest" | "fun";

export interface BehaviorConfig {
  autonomous_enabled: boolean;
  weights: Record<Group, number>;
  idle_delay: [number, number]; // seconds between two activities
}

export const DEFAULT_BEHAVIOR: BehaviorConfig = {
  autonomous_enabled: true,
  weights: { browse: 30, explore: 25, idle: 20, social: 10, rest: 10, fun: 5 },
  idle_delay: [1, 4],
};

export interface Seat {
  id: string;
  pos: Point2;
  yaw: number;
  approach: Point2;
}

export interface Bench {
  x: number;
  z: number;
  len: number; // along z
  depth: number;
  yaw: number; // direction the sitters face
  seats: Seat[];
  obstacle: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Two benches against the side walls, between the 2nd and 3rd rows of shelves. */
export function benchSpots(layout: StoreLayout): Bench[] {
  const W = layout.store.width;
  const out: Bench[] = [];
  const z = 1.75;
  for (const side of [-1, 1]) {
    const x = side * (W / 2 - 0.6);
    const yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2; // facing into the shop
    const seats: Seat[] = [-1, 1].map((k) => ({
      id: `bench${side > 0 ? "R" : "L"}${k > 0 ? 2 : 1}`,
      pos: { x, z: z + k * 0.32 },
      yaw,
      approach: { x: x - side * 0.85, z: z + k * 0.32 },
    }));
    out.push({
      x,
      z,
      len: 1.3,
      depth: 0.42,
      yaw,
      seats,
      obstacle: { minX: x - 0.24, maxX: x + 0.24, minZ: z - 0.68, maxZ: z + 0.68 },
    });
  }
  return out;
}

export interface AutoPlan {
  id: string; // behaviour id from the spec (BROWSE_SHELF, REST_BENCH…)
  group: Group;
  state: TopState; // top-level state while doing it
  target?: Point2; // walk here first
  seat?: Seat; // or sit down here (walk to the approach point, then step in)
  face?: number; // yaw once there
  anim: AnimState;
  seconds: number;
  emote?: string;
  partner?: string; // social: the other Chibi
  prop?: "cup";
  /** a short extra moment inside the activity, e.g. a yawn on the bench */
  extra?: { id: string; anim: AnimState; at: number; seconds: number };
}

export interface Partner {
  id: string;
  pos: Point2;
}

export interface PlanContext {
  pos: Point2;
  rand: () => number;
  nav: NavGrid;
  shelves: ShelfLayout[];
  freeSeats: Seat[];
  readSpots: { pos: Point2; yaw: number }[];
  partners: Partner[]; // idle Chibis nearby that may be greeted
  /** nobody stands there or is heading there (so two Chibis never share a spot) */
  spotFree?: (p: Point2) => boolean;
}

const usable = (c: PlanContext, p: Point2 | undefined): p is Point2 => !!p && c.nav.isPointFree(p) && (c.spotFree?.(p) ?? true);

const between = (r: () => number, a: number, b: number) => a + (b - a) * r();
const pick = <T,>(r: () => number, xs: T[]): T | undefined => (xs.length ? xs[Math.floor(r() * xs.length) % xs.length] : undefined);

interface Def {
  id: string;
  group: Group;
  share: number; // share of its group's weight
  cooldown: number; // seconds before the same Chibi does it again
  plan: (c: PlanContext) => AutoPlan | null;
}

const faceTo = (from: Point2, to: Point2) => Math.atan2(to.x - from.x, to.z - from.z);

export const CATALOG: Def[] = [
  {
    id: "BROWSE_SHELF",
    group: "browse",
    share: 0.72,
    cooldown: 6,
    plan: (c) => {
      const s = pick(c.rand, c.shelves.filter((x) => x.wait_positions.some((p) => usable(c, p))));
      const spot = s && pick(c.rand, s.wait_positions.filter((p) => usable(c, p)));
      if (!s || !spot) return null;
      return { id: "BROWSE_SHELF", group: "browse", state: "BROWSING", target: spot, face: s.transform.rot + Math.PI, anim: "browse", seconds: between(c.rand, 3, 5.5) };
    },
  },
  {
    id: "EXAMINE_PRICE",
    group: "browse",
    share: 0.28,
    cooldown: 12,
    plan: (c) => {
      const s = pick(c.rand, c.shelves.filter((x) => x.wait_positions.some((p) => usable(c, p))));
      const spot = s && pick(c.rand, s.wait_positions.filter((p) => usable(c, p)));
      if (!s || !spot) return null;
      return { id: "EXAMINE_PRICE", group: "browse", state: "BROWSING", target: spot, face: s.transform.rot + Math.PI, anim: "nod", seconds: between(c.rand, 2.2, 3.2) };
    },
  },
  {
    id: "WALK_EXPLORE",
    group: "explore",
    share: 0.8,
    cooldown: 0,
    plan: (c) => {
      for (let i = 0; i < 6; i++) {
        const p = c.nav.randomFreePoint(c.rand);
        if (usable(c, p)) return { id: "WALK_EXPLORE", group: "explore", state: "NAVIGATING", target: p, anim: "look", seconds: between(c.rand, 1, 2) };
      }
      return null;
    },
  },
  {
    id: "READ_SIGN",
    group: "explore",
    share: 0.2,
    cooldown: 25,
    plan: (c) => {
      const s = pick(c.rand, c.readSpots.filter((p) => usable(c, p.pos)));
      return s ? { id: "READ_SIGN", group: "explore", state: "BROWSING", target: s.pos, face: s.yaw, anim: "lookup", seconds: between(c.rand, 2.5, 4) } : null;
    },
  },
  { id: "IDLE_BREATHE", group: "idle", share: 0.4, cooldown: 0, plan: (c) => ({ id: "IDLE_BREATHE", group: "idle", state: "IDLE", anim: "idle", seconds: between(c.rand, 2, 4) }) },
  { id: "IDLE_LOOK", group: "idle", share: 0.4, cooldown: 4, plan: (c) => ({ id: "IDLE_LOOK", group: "idle", state: "IDLE", anim: "look", seconds: between(c.rand, 2, 3.2) }) },
  { id: "IDLE_STRETCH", group: "idle", share: 0.2, cooldown: 30, plan: (c) => ({ id: "IDLE_STRETCH", group: "idle", state: "IDLE", anim: "stretch", seconds: 1.8 + c.rand() * 0.4 }) },
  {
    id: "SOCIAL_WAVE",
    group: "social",
    share: 0.6,
    cooldown: 40,
    plan: (c) => {
      const p = pick(c.rand, c.partners);
      return p ? { id: "SOCIAL_WAVE", group: "social", state: "SOCIALIZING", face: faceTo(c.pos, p.pos), anim: "wave", seconds: 1.4, emote: "♪", partner: p.id } : null;
    },
  },
  {
    id: "SOCIAL_NOD",
    group: "social",
    share: 0.4,
    cooldown: 40,
    plan: (c) => {
      const p = pick(c.rand, c.partners);
      return p ? { id: "SOCIAL_NOD", group: "social", state: "SOCIALIZING", face: faceTo(c.pos, p.pos), anim: "nod", seconds: 1.3, partner: p.id } : null;
    },
  },
  {
    id: "REST_BENCH",
    group: "rest",
    share: 0.55,
    cooldown: 45,
    plan: (c) => {
      const s = pick(c.rand, c.freeSeats);
      if (!s) return null;
      const seconds = between(c.rand, 6, 10);
      // FUN_YAWN: now and then a sleepy yawn on the bench
      const extra = c.rand() < 0.5 ? { id: "FUN_YAWN", anim: "yawn" as const, at: between(c.rand, 1.5, seconds - 3), seconds: 1.8 } : undefined;
      return { id: "REST_BENCH", group: "rest", state: "RESTING", seat: s, face: s.yaw, anim: "sit", seconds, extra };
    },
  },
  {
    id: "REST_DRINK",
    group: "rest",
    share: 0.45,
    cooldown: 60,
    plan: (c) => {
      const s = pick(c.rand, c.freeSeats);
      return s ? { id: "REST_DRINK", group: "rest", state: "RESTING", seat: s, face: s.yaw, anim: "sit", seconds: between(c.rand, 6, 9), prop: "cup" } : null;
    },
  },
  { id: "FUN_DANCE", group: "fun", share: 0.4, cooldown: 90, plan: (c) => ({ id: "FUN_DANCE", group: "fun", state: "PLAYING", face: 0, anim: "dance", seconds: between(c.rand, 2, 3), emote: "♪" }) },
  { id: "FUN_POSE", group: "fun", share: 0.4, cooldown: 60, plan: () => ({ id: "FUN_POSE", group: "fun", state: "PLAYING", face: 0, anim: "pose", seconds: 1.8, emote: "★" }) },
  { id: "FUN_SPIN", group: "fun", share: 0.2, cooldown: 90, plan: () => ({ id: "FUN_SPIN", group: "fun", state: "PLAYING", anim: "spin", seconds: 1.5 }) },
];

export interface PickState {
  recent: string[]; // most recent last
  lastDone: Map<string, number>; // id → clock seconds
  now: number;
  cameraBusy: boolean; // the camera is on a product: no fun, less crowd movement
  hostSpeaking?: boolean; // the host / AI voice is talking: no fun, calmer crowd
}

/** Weighted choice of the next autonomous activity, or null if nothing fits right now. */
export function pickBehavior(cfg: BehaviorConfig, st: PickState, ctx: PlanContext): AutoPlan | null {
  if (!cfg.autonomous_enabled) return null;
  const options = CATALOG.map((d) => {
    let w = (cfg.weights[d.group] ?? 0) * d.share;
    if (st.cameraBusy && d.group === "fun") w = 0;
    if (st.cameraBusy && d.group === "explore") w *= 0.4;
    if (st.hostSpeaking && d.group === "fun") w = 0;
    if (st.hostSpeaking && d.group === "explore") w *= 0.6;
    const last = st.lastDone.get(d.id);
    if (last !== undefined && st.now - last < d.cooldown) w = 0;
    const n = st.recent.length;
    if (n >= 2 && st.recent[n - 1] === d.id && st.recent[n - 2] === d.id) w = 0; // never 3× in a row
    if (d.group === "social" && !ctx.partners.length) w = 0;
    if (d.group === "rest" && !ctx.freeSeats.length) w = 0;
    return { d, w };
  }).filter((o) => o.w > 0);
  while (options.length) {
    const total = options.reduce((s, o) => s + o.w, 0);
    let r = ctx.rand() * total;
    let i = 0;
    for (; i < options.length - 1; i++) {
      r -= options[i].w;
      if (r <= 0) break;
    }
    const plan = options[i].d.plan(ctx);
    if (plan) return plan;
    options.splice(i, 1); // no valid target: try another activity
  }
  return null;
}

/** Deterministic per-Chibi random numbers. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
