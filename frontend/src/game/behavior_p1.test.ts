// Chibi behaviour spec V3 — P1: missing animation clips (T12), host speaking (T15), level of
// detail policy (T16), advanced social / fun behaviours, behaviour settings from the dashboard.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvatarInfo, CharacterAction, SceneConfig } from "../types/protocol";
import { DEFAULT_SCENE } from "../types/protocol";
import type { AnimState } from "./AnimationFSM";
import { MAX_DURATION } from "./AnimationFSM";
import { CATALOG, DEFAULT_BEHAVIOR, mulberry, pickBehavior } from "./behaviors";
import { CLIP_OF, ClipLibrary, PROCEDURAL_CLIPS, REQUIRED_CLIPS } from "./clips";
import { behaviorFromScene, GameEngine } from "./GameEngine";
import { lodPolicy, lodTier, LOD } from "./lod";
import { LAYOUT } from "./testFixtures";

function engineWith(n: number, seed = 1) {
  const e = new GameEngine(() => undefined);
  e.setLayout(LAYOUT);
  for (let i = 0; i < n; i++) {
    const info: AvatarInfo = { avatar_id: `av_${i}`, nickname: `khach${i}`, unique_id: `khach${i}`, appearance_seed: seed * 1000 + i * 7919, is_demo: true };
    e.handle({ type: "AVATAR_SPAWN", sequence: i + 1, avatar: info });
  }
  return e;
}

function run(e: GameEngine, seconds: number, onTick?: () => void) {
  for (let t = 0; t < seconds; t += 0.05) {
    e.step(0.05);
    onTick?.();
  }
}

const ALL_STATES = Object.keys(MAX_DURATION) as AnimState[];

afterEach(() => vi.restoreAllMocks());

describe("missing animation clips (T12)", () => {
  it("the built-in Chibi has every required clip, every state plays a named clip", () => {
    for (const c of REQUIRED_CLIPS) expect(PROCEDURAL_CLIPS).toContain(c);
    for (const s of ALL_STATES) expect(CLIP_OF[s], s).toBeTruthy();
    expect(new ClipLibrary().missing()).toEqual([]);
  });

  it("falls back to the nearest clip in meaning and warns once per clip", () => {
    const warn = vi.fn();
    const lib = new ClipLibrary(PROCEDURAL_CLIPS.filter((c) => c !== "dance"), warn);
    expect(lib.resolve("dance")).toBe("cheer");
    expect(lib.resolve("dance")).toBe("cheer");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('thiếu clip "dance"');
    expect(lib.warnings).toEqual(["dance → cheer"]);
    const lib2 = new ClipLibrary(PROCEDURAL_CLIPS.filter((c) => c !== "dance" && c !== "cheer"), () => undefined);
    expect(lib2.resolve("dance")).toBe("wave");
    expect(lib2.resolve("celebrate")).toBe("wave");
    expect(new ClipLibrary(PROCEDURAL_CLIPS.filter((c) => c !== "present"), () => undefined).resolve("show")).toBe("hold");
  });

  it("a rig with no clips at all: everything stands in idle, nothing throws", () => {
    const lib = new ClipLibrary([], () => undefined);
    for (const s of ALL_STATES) expect(lib.resolve(s)).toBe("idle");
  });

  it("a Chibi asked to dance without a dance clip cheers instead and the shop keeps running", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const e = engineWith(12, 4);
    e.setMissingClips(["dance", "spin", "yawn", "stand_up", "sit"]);
    run(e, 3);
    const a = e.avatars.get("av_0")!;
    e.handle({ type: "SOCIAL_EFFECT", sequence: 50, kind: "dance", avatar_id: "av_0" });
    expect(a.state).toBe("dance"); // the behaviour is still FUN_DANCE …
    expect(a.pose).toBe("cheer"); // … drawn with the nearest clip
    expect(a.behaviorId).toBe("FUN_DANCE");
    expect(() =>
      run(e, 90, () => {
        for (const x of e.avatars.values()) expect(e.clips.has(CLIP_OF[x.pose]) || x.pose === "idle").toBe(true);
      }),
    ).not.toThrow();
    expect(e.clips.warnings).toContain("dance → cheer");
    expect((e.debugState() as unknown as { clipWarnings: string[] }).clipWarnings).toContain("dance → cheer");
  });
});

describe("advanced life: stand up, yawn, cheer (P1 social / fun)", () => {
  it("getting up from the bench plays stand_up before walking away", () => {
    const e = engineWith(1, 9);
    const a = e.avatars.get("av_0")!;
    run(e, 2);
    a.effect("sit");
    const states: string[] = [];
    run(e, 20, () => {
      if (states[states.length - 1] !== a.state) states.push(a.state);
    });
    const i = states.indexOf("sit");
    expect(i).toBeGreaterThanOrEqual(0);
    const after = states.slice(i);
    expect(after.indexOf("standup")).toBeGreaterThan(0);
    expect(after[after.indexOf("standup") + 1]).toBe("walk");
  });

  it("now and then a Chibi yawns on the bench (seated, then sits on)", () => {
    const e = engineWith(16, 3);
    let yawnSeated = 0;
    let yawnStanding = 0;
    run(e, 200, () => {
      for (const a of e.avatars.values())
        if (a.state === "yawn") {
          if (a.sittingOnBench) yawnSeated++;
          else yawnStanding++;
        }
    });
    expect(yawnSeated).toBeGreaterThan(0);
    expect(yawnStanding).toBe(0);
    expect([...e.avatars.values()].some((a) => a.history.includes("FUN_YAWN"))).toBe(true);
  });

  it("when a Chibi puts its product back, up to two free neighbours clap (FUN_CHEER)", () => {
    const e = engineWith(4, 2);
    e.behavior = { ...DEFAULT_BEHAVIOR, weights: { browse: 0, explore: 0, idle: 10, social: 0, rest: 0, fun: 5 } };
    run(e, 12); // everyone is inside, standing around
    const stand = LAYOUT.shelves.find((s) => s.code === "KE_02")!.stand_positions[0];
    ["av_1", "av_2", "av_3"].forEach((id, k) => (e.avatars.get(id)!.pos = { x: stand.x - 1 + k * 0.7, z: stand.z + 1.6 }));
    const act: CharacterAction & { sequence: number } = {
      type: "CHARACTER_ACTION", sequence: 90, command_id: "c1", avatar_id: "av_0", product_id: "TRA_CA_GAI_LEO",
      shelf_id: "KE_02", slot_id: "S2", stand_index: 0, action: "WALK_PICKUP_SHOW", parameters: { show_seconds: 2, camera_priority: 50 },
    };
    e.handle(act);
    const a0 = e.avatars.get("av_0")!;
    let cheered = new Set<string>();
    run(e, 30, () => {
      for (const id of ["av_1", "av_2", "av_3"]) {
        const a = e.avatars.get(id)!;
        if (a.state === "cheer") cheered.add(id);
      }
    });
    expect(a0.completed).toContain("c1");
    expect(cheered.size).toBeGreaterThanOrEqual(1);
    expect(cheered.size).toBeLessThanOrEqual(2);
    // the same Chibi does not clap again within a minute
    const first = cheered;
    cheered = new Set();
    e.handle({ ...act, command_id: "c2", sequence: 91 });
    run(e, 25, () => {
      for (const id of ["av_1", "av_2", "av_3"]) if (e.avatars.get(id)!.state === "cheer") cheered.add(id);
    });
    expect(a0.completed).toContain("c2");
    for (const id of cheered) expect(first.has(id), `${id} clapped twice in a minute`).toBe(false);
  });
});

describe("while the host / AI voice talks (T15)", () => {
  it("the scheduler never picks fun while speaking, and picks less crowd movement", () => {
    const ctx = { pos: { x: 0, z: 0 }, rand: mulberry(5), nav: engineWith(0).nav!, shelves: LAYOUT.shelves, freeSeats: [], readSpots: [], partners: [] };
    const cfg = { ...DEFAULT_BEHAVIOR, weights: { ...DEFAULT_BEHAVIOR.weights, fun: 60 } };
    let fun = 0;
    for (let i = 0; i < 1500; i++) {
      const p = pickBehavior(cfg, { recent: [], lastDone: new Map(), now: 0, cameraBusy: false, hostSpeaking: true }, ctx);
      if (p?.group === "fun") fun++;
    }
    expect(fun).toBe(0);
  });

  it("Chibis keep moving and animating while the voice talks; no behaviour makes any sound", () => {
    let plays = 0;
    let speaks = 0;
    // anything a behaviour could use to make a sound
    vi.stubGlobal("Audio", class { play() { plays++; return Promise.resolve(); } });
    vi.stubGlobal("speechSynthesis", { speak: () => speaks++, cancel: () => undefined });
    const e = engineWith(12, 6);
    e.behavior = { ...DEFAULT_BEHAVIOR, weights: { ...DEFAULT_BEHAVIOR.weights, fun: 40 } };
    run(e, 10);
    e.setSpeaking(true);
    const start = new Map([...e.avatars.values()].map((a) => [a.info.avatar_id, { ...a.pos }]));
    const funWhileSpeaking: string[] = [];
    const histLen = new Map([...e.avatars.values()].map((a) => [a.info.avatar_id, a.history.length]));
    run(e, 40);
    for (const a of e.avatars.values()) {
      for (const h of a.history.slice(histLen.get(a.info.avatar_id))) if (/^FUN_(DANCE|POSE|SPIN)$/.test(h)) funWhileSpeaking.push(h);
    }
    expect(funWhileSpeaking).toEqual([]);
    const moved = [...e.avatars.values()].filter((a) => Math.hypot(a.pos.x - start.get(a.info.avatar_id)!.x, a.pos.z - start.get(a.info.avatar_id)!.z) > 0.5);
    expect(moved.length).toBeGreaterThanOrEqual(6); // the shop is alive, not frozen
    // a viewer's own request still works while the voice talks
    e.handle({ type: "SOCIAL_EFFECT", sequence: 70, kind: "dance", avatar_id: "av_1" });
    run(e, 8);
    expect(e.avatars.get("av_1")!.history).toContain("FUN_DANCE");
    // voice done: fun comes back
    e.setSpeaking(false);
    run(e, 150);
    expect([...e.avatars.values()].some((a) => a.history.some((h) => /^FUN_(DANCE|POSE|SPIN)$/.test(h)))).toBe(true);
    expect(plays).toBe(0);
    expect(speaks).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe("behaviour settings from the dashboard (spec §5, §11)", () => {
  it("weights and the on/off switch come from the saved scene", () => {
    const sc: SceneConfig = { ...DEFAULT_SCENE, chibi_w_fun: 0, chibi_w_rest: 40, chibi_autonomous: true };
    const b = behaviorFromScene(sc);
    expect(b.weights).toEqual({ browse: 30, explore: 25, idle: 20, social: 10, rest: 40, fun: 0 });
    const e = engineWith(6, 8);
    e.setScene({ ...DEFAULT_SCENE, chibi_autonomous: false });
    run(e, 40);
    for (const a of e.avatars.values()) {
      expect(a.history.filter((h) => CATALOG.some((c) => c.id === h))).toEqual([]); // only walked in
      expect(["IDLE", "ENTERING"]).toContain(a.topState);
    }
    // a viewer's command still works with autonomous life switched off
    e.handle({ type: "SOCIAL_EFFECT", sequence: 80, kind: "wave", avatar_id: "av_2" });
    expect(e.avatars.get("av_2")!.behaviorId).toBe("SOCIAL_WAVE");
  });
});

describe("level of detail (T16)", () => {
  it("a quiet shop draws everyone in full; a crowd or a slow PC thins out far Chibis first", () => {
    expect(lodPolicy(10, 60).level).toBe(0);
    expect(lodPolicy(30, 60).level).toBe(1);
    expect(lodPolicy(50, 60).level).toBe(2);
    expect(lodPolicy(12, 18).level).toBe(2); // slow PC
    expect(lodPolicy(4, 10).level).toBe(0); // a few Chibis are never the problem
    const p = lodPolicy(50, 60);
    expect(p.near).toBeLessThan(p.far);
  });

  it("the Chibi in focus or carrying a box is never reduced to far / hidden", () => {
    LOD.near = 6;
    LOD.far = 13;
    expect(lodTier(30, false, true)).toBe("reduced");
    expect(lodTier(3, false, true)).toBe("full");
    expect(lodTier(30, false, false)).toBe("hidden");
    expect(lodTier(8, true, false)).toBe("reduced");
    expect(lodTier(20, true, false)).toBe("far");
    LOD.near = 12;
    LOD.far = 99;
  });
});
