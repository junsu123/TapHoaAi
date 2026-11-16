// Headless simulator for the Chibi behaviour system (spec V3 §13): Chibis live in the shop
// for minutes of simulated time; we check what they do, never what they look like.

import { describe, expect, it } from "vitest";
import type { AvatarInfo, CharacterAction, ClientGameMessage } from "../types/protocol";
import { CATALOG, DEFAULT_BEHAVIOR, mulberry, pickBehavior, type TopState } from "./behaviors";
import { GameEngine } from "./GameEngine";
import { LAYOUT } from "./testFixtures";

const TOP_STATES: TopState[] = [
  "SPAWNING", "ENTERING", "IDLE", "NAVIGATING", "BROWSING", "WAITING_SLOT", "PICKING", "HOLDING", "PRESENTING",
  "RETURNING_ITEM", "SOCIALIZING", "PLAYING", "RESTING", "LEAVING", "DESPAWNED", "ERROR_RECOVERY",
];

/** True geometry (not the inflated walk map): shelves, counter, benches, tea table. */
function insideSolid(e: GameEngine, x: number, z: number): boolean {
  const c = LAYOUT.store.counter;
  if (Math.abs(x - c.x) < c.w / 2 && Math.abs(z - c.z) < c.d / 2) return true;
  if (LAYOUT.shelves.some((s) => Math.abs(x - s.transform.x) < s.transform.w / 2 && Math.abs(z - s.transform.z) < s.transform.d / 2)) return true;
  const rects = [...e.benches.map((b) => b.obstacle), ...(e.spot ? [e.spot.obstacle] : [])];
  return rects.some((r) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ);
}

function engineWith(n: number, seed = 1) {
  const sent: ClientGameMessage[] = [];
  const e = new GameEngine((m) => sent.push(m));
  e.setLayout(LAYOUT);
  for (let i = 0; i < n; i++) {
    const info: AvatarInfo = { avatar_id: `av_${i}`, nickname: `khach${i}`, unique_id: `khach${i}`, appearance_seed: seed * 1000 + i * 7919, is_demo: true };
    e.handle({ type: "AVATAR_SPAWN", sequence: i + 1, avatar: info });
  }
  return { e, sent };
}

function run(e: GameEngine, seconds: number, onTick?: (t: number) => void) {
  for (let t = 0; t < seconds; t += 0.05) {
    e.step(0.05);
    onTick?.(t);
  }
}

describe("autonomous life (T03: two minutes without comments)", () => {
  it("every Chibi keeps doing varied things, never 3× the same in a row, always one valid top state", () => {
    const { e } = engineWith(12);
    const statesSeen = new Map<string, Set<TopState>>();
    const moved = new Map<string, number>();
    const last = new Map<string, { x: number; z: number }>();
    run(e, 120, () => {
      for (const a of e.avatars.values()) {
        expect(TOP_STATES).toContain(a.topState);
        // never inside a shelf, the counter, the tea table or a bench (except sitting on it)
        const seated = a.sittingOnBench || (a.phase === "auto" && a.auto?.plan.seat);
        if (!seated) expect(insideSolid(e, a.pos.x, a.pos.z), `${a.info.nickname} inside furniture at ${a.pos.x.toFixed(2)},${a.pos.z.toFixed(2)} (${a.phase})`).toBe(false);
        if (!statesSeen.has(a.info.avatar_id)) statesSeen.set(a.info.avatar_id, new Set());
        statesSeen.get(a.info.avatar_id)!.add(a.topState);
        const p = last.get(a.info.avatar_id);
        if (p) moved.set(a.info.avatar_id, (moved.get(a.info.avatar_id) ?? 0) + Math.hypot(a.pos.x - p.x, a.pos.z - p.z));
        last.set(a.info.avatar_id, { ...a.pos });
      }
    });
    for (const a of e.avatars.values()) {
      const kinds = new Set(a.recent.concat(a.history.filter((h) => CATALOG.some((c) => c.id === h))));
      expect(kinds.size, `${a.info.nickname} did ${[...kinds]}`).toBeGreaterThanOrEqual(3);
      expect(moved.get(a.info.avatar_id)!).toBeGreaterThan(4); // not a statue
      const h = a.history;
      for (let i = 2; i < h.length; i++) expect(h[i] === h[i - 1] && h[i] === h[i - 2], `${h}`).toBe(false);
    }
    const all = new Set<TopState>();
    for (const s of statesSeen.values()) for (const x of s) all.add(x);
    expect([...all]).toEqual(expect.arrayContaining(["IDLE", "NAVIGATING", "BROWSING"]));
  });

  it("benches: one Chibi per seat, seats are given back", () => {
    const { e } = engineWith(16, 3);
    const owners = new Map<string, string>();
    let sat = 0;
    run(e, 150, () => {
      const now = new Map<string, string>();
      for (const a of e.avatars.values()) {
        const s = a.sittingOnBench;
        if (s) {
          expect(now.has(s.id), `seat ${s.id} twice`).toBe(false);
          now.set(s.id, a.info.avatar_id);
          if (!owners.has(s.id)) sat++;
        }
      }
      owners.clear();
      for (const [k, v] of now) owners.set(k, v);
    });
    expect(sat).toBeGreaterThan(0);
    // all seats free again once everybody leaves
    for (const a of e.avatars.values()) a.exit();
    run(e, 30);
    const st = e.debugState() as unknown as { seats: Record<string, boolean> };
    expect(Object.values(st.seats).every((taken) => !taken)).toBe(true);
  });

  it("scheduler: weights respected, cooldowns, no fun while the camera is on a product", () => {
    const rand = mulberry(42);
    const ctx = { pos: { x: 0, z: 0 }, rand, nav: new GameEngine(() => undefined).nav!, shelves: LAYOUT.shelves, freeSeats: [], readSpots: [], partners: [] };
    const e = new GameEngine(() => undefined);
    e.setLayout(LAYOUT);
    ctx.nav = e.nav!;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const p = pickBehavior(DEFAULT_BEHAVIOR, { recent: [], lastDone: new Map(), now: 0, cameraBusy: false }, ctx)!;
      counts[p.group] = (counts[p.group] ?? 0) + 1;
    }
    // no seats / partners in this context: browse 30, explore 25, idle 20, fun 5 → shares of 80
    expect(counts.browse / 2000).toBeGreaterThan(0.3);
    expect(counts.browse).toBeGreaterThan(counts.idle);
    expect(counts.fun / 2000).toBeLessThan(0.12);
    for (let i = 0; i < 300; i++) {
      const p = pickBehavior(DEFAULT_BEHAVIOR, { recent: [], lastDone: new Map(), now: 0, cameraBusy: true }, ctx)!;
      expect(p.group).not.toBe("fun");
    }
    const dance = pickBehavior({ ...DEFAULT_BEHAVIOR, weights: { browse: 0, explore: 0, idle: 0, social: 0, rest: 0, fun: 1 } }, { recent: [], lastDone: new Map([["FUN_DANCE", 0], ["FUN_POSE", 0], ["FUN_SPIN", 0]]), now: 10, cameraBusy: false }, ctx);
    expect(dance).toBeNull(); // all fun activities cooling down
    expect(pickBehavior({ ...DEFAULT_BEHAVIOR, autonomous_enabled: false }, { recent: [], lastDone: new Map(), now: 0, cameraBusy: false }, ctx)).toBeNull();
  });
});

describe("arrivals (T01, T02)", () => {
  it("20 viewers at once: 20 distinct Chibis that spread out from the door", () => {
    const { e } = engineWith(20, 5);
    expect(new Set([...e.avatars.keys()]).size).toBe(20);
    expect([...e.avatars.values()].every((a) => a.topState === "ENTERING")).toBe(true);
    run(e, 12);
    const ps = [...e.avatars.values()].map((a) => a.pos);
    let close = 0;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (Math.hypot(ps[i].x - ps[j].x, ps[i].z - ps[j].z) < 0.3) close++;
    expect(close).toBeLessThanOrEqual(2);
    const door = { x: 0, z: 7.4 };
    expect(ps.filter((p) => Math.hypot(p.x - door.x, p.z - door.z) < 1).length).toBeLessThanOrEqual(3);
  });
});

describe("direct commands and the product lifecycle (spec §4, §12)", () => {
  const action = (id: string, product = "TRA_CA_GAI_LEO"): CharacterAction & { sequence: number } => ({
    type: "CHARACTER_ACTION", sequence: 1, command_id: id, avatar_id: "av_0", product_id: product,
    shelf_id: product === "TRA_CA_GAI_LEO" ? "KE_02" : "KE_03", slot_id: "S2", stand_index: 0, action: "WALK_PICKUP_SHOW",
    parameters: { show_seconds: 3, camera_priority: 50 },
  });

  it("a product command interrupts autonomous life; telemetry milestones in order; back to life after", () => {
    const { e, sent } = engineWith(1);
    run(e, 15); // let it get busy with something
    e.handle(action("c1"));
    const a = e.avatars.get("av_0")!;
    const seen: TopState[] = [];
    run(e, 40, () => {
      if (seen[seen.length - 1] !== a.topState) seen.push(a.topState);
    });
    const phases = sent.filter((m) => m.type === "ACTION_PROGRESS" && "command_id" in m && m.command_id === "c1").map((m) => (m as { phase: string }).phase);
    expect(phases.filter((p) => p === p.toUpperCase())).toEqual(expect.arrayContaining(["PATH_FOUND", "REACHED_SHELF", "PICKED", "PRESENTED", "RETURNED"]));
    expect(sent.some((m) => m.type === "ACTION_COMPLETED" && m.command_id === "c1")).toBe(true);
    for (const s of ["NAVIGATING", "PICKING", "HOLDING", "PRESENTING", "RETURNING_ITEM"] as TopState[]) expect(seen).toContain(s);
    expect(a.held).toBeNull();
    // after the product it lives on (scheduler picked something again)
    expect(a.history.slice(-3).some((h) => CATALOG.some((c) => c.id === h))).toBe(true);
  });

  it("dance while busy is queued (max 2, 4 s duplicate window) and played afterwards", () => {
    const { e } = engineWith(1);
    run(e, 3);
    e.handle(action("c2"));
    const a = e.avatars.get("av_0")!;
    for (let i = 0; i < 100; i++) e.handle({ type: "SOCIAL_EFFECT", sequence: 10 + i, kind: "dance", avatar_id: "av_0" }); // T08 spam
    expect(a.direct.length).toBe(1);
    e.handle({ type: "SOCIAL_EFFECT", sequence: 200, kind: "wave", avatar_id: "av_0" });
    e.handle({ type: "SOCIAL_EFFECT", sequence: 201, kind: "pose", avatar_id: "av_0" });
    expect(a.direct.length).toBe(2); // capped
    let danced = false;
    run(e, 40, () => {
      if (a.behaviorId === "FUN_POSE" || a.behaviorId === "SOCIAL_WAVE") danced = true;
    });
    expect(danced).toBe(true);
    expect(a.direct.length).toBe(0);
  });

  it("likes are an emote only; 'xem giá' points at the box being shown", () => {
    const { e } = engineWith(1);
    run(e, 3);
    const a = e.avatars.get("av_0")!;
    const before = a.behaviorId;
    e.handle({ type: "SOCIAL_EFFECT", sequence: 3, kind: "like", avatar_id: "av_0" });
    expect(a.emote?.icon).toBe("❤");
    expect(a.behaviorId).toBe(before);
    e.handle(action("c3"));
    run(e, 30, () => undefined);
  });

  it("a product that cannot be reached: recovery walk, no teleport, keeps living (T10)", () => {
    const { e, sent } = engineWith(1);
    run(e, 2);
    const a = e.avatars.get("av_0")!;
    e.handle({ ...action("c4"), shelf_id: "NO_SUCH_SHELF" });
    expect(sent.some((m) => m.type === "ACTION_FAILED" && m.command_id === "c4")).toBe(true);
    let maxStep = 0;
    let prev = { ...a.pos };
    run(e, 20, () => {
      maxStep = Math.max(maxStep, Math.hypot(a.pos.x - prev.x, a.pos.z - prev.z));
      prev = { ...a.pos };
    });
    expect(maxStep).toBeLessThan(0.2); // walking speed only
    expect(a.topState).not.toBe("ERROR_RECOVERY");
  });

  it("leaving: gives back the seat and the box, walks out (T11, T20)", () => {
    const { e } = engineWith(1, 9);
    const a = e.avatars.get("av_0")!;
    a.effect("sit");
    run(e, 8);
    e.handle(action("c5"));
    run(e, 4);
    e.handle({ type: "AVATAR_EXIT", sequence: 99, avatar_id: "av_0", reason: "user_leave" });
    expect(a.held).toBeNull();
    expect(a.topState).toBe("LEAVING");
    run(e, 30);
    expect(e.avatars.has("av_0")).toBe(false);
    const st = e.debugState() as unknown as { seats: Record<string, boolean> };
    expect(Object.values(st.seats).every((taken) => !taken)).toBe(true);
  });
});
