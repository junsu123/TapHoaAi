import { describe, expect, it } from "vitest";
import type { CharacterAction, ClientGameMessage, StoreLayout } from "../types/protocol";
import { SequenceTracker } from "../lib/ws";
import { AnimationFSM } from "./AnimationFSM";
import { GameEngine } from "./GameEngine";
import { NavGrid, pathLength } from "./Navigation";
import { sanitizeLabel } from "./nameTexture";

function shelf(code: string, x: number, z: number) {
  const front = z + 0.3 + 0.55;
  return {
    code,
    name: code,
    transform: { x, z, rot: 0, w: 2.4, d: 0.6, h: 1.6 },
    stand_positions: [-0.7, 0, 0.7].map((dx) => ({ x: x + dx, z: front })),
    wait_positions: [{ x: x - 1.75, z: front }, { x: x + 1.75, z: front }],
    slots: [-0.7, 0, 0.7].map((dx, i) => ({
      code: `S${i + 1}`,
      product_id: code === "KE_02" && i === 1 ? "TRA_CA_GAI_LEO" : code === "KE_03" && i === 1 ? "TRA_BA_KICH" : null,
      local: { x: dx, y: 0.55, z: 0.18 },
    })),
  };
}

export const LAYOUT: StoreLayout = {
  version: 1,
  store: { width: 12, depth: 16, door: { x: 0, z: 7.6 }, counter: { x: 0, z: -6.6, w: 3.2, d: 0.8 } },
  shelves: [
    shelf("KE_01", -3, -3.5), shelf("KE_02", 3, -3.5), shelf("KE_03", -3, 0),
    shelf("KE_04", 3, 0), shelf("KE_05", -3, 3.5), shelf("KE_06", 3, 3.5),
  ],
  products: [
    { id: "TRA_CA_GAI_LEO", sku: "DEMO-TCGL-01", name: "Trà cà gai leo", price: 85000, currency: "VND", image_url: null, box_size: { w: 0.2, h: 0.28, d: 0.08 } },
    { id: "TRA_BA_KICH", sku: "DEMO-TBK-01", name: "Trà ba kích", price: null, currency: "VND", image_url: null, box_size: { w: 0.2, h: 0.28, d: 0.08 } },
  ],
};

function insideAnyShelf(nav: NavGrid, x: number, z: number) {
  return LAYOUT.shelves.some(
    (s) => Math.abs(x - s.transform.x) <= s.transform.w / 2 && Math.abs(z - s.transform.z) <= s.transform.d / 2,
  ) || !nav.isPointFree({ x, z });
}

describe("Navigation (GAME-04)", () => {
  const nav = new NavGrid(LAYOUT);

  it("stand and wait positions are walkable", () => {
    for (const s of LAYOUT.shelves) for (const p of [...s.stand_positions, ...s.wait_positions]) expect(nav.isPointFree(p)).toBe(true);
  });

  it("finds a path from the door to every shelf without crossing a shelf", () => {
    for (const s of LAYOUT.shelves) {
      for (const goal of s.stand_positions) {
        const path = nav.findPath({ x: 0, z: 7.3 }, goal)!;
        expect(path).not.toBeNull();
        expect(path[path.length - 1]).toEqual(goal);
        for (let i = 1; i < path.length; i++) {
          const a = path[i - 1];
          const b = path[i];
          const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.05);
          for (let k = 0; k <= n; k++) {
            const x = a.x + ((b.x - a.x) * k) / n;
            const z = a.z + ((b.z - a.z) * k) / n;
            expect(insideAnyShelf(nav, x, z)).toBe(false);
          }
        }
      }
    }
  });

  it("goes around a shelf instead of through it", () => {
    const from = { x: 3, z: -1.0 }; // in front of KE_04... behind KE_02
    const to = shelf("KE_02", 3, -3.5).stand_positions[1];
    const path = nav.findPath(from, to)!;
    expect(pathLength(path)).toBeGreaterThan(Math.hypot(to.x - from.x, to.z - from.z) - 0.01);
  });

  it("snaps a blocked target to the nearest free cell", () => {
    const path = nav.findPath({ x: 0, z: 6 }, { x: 3, z: -3.5 }); // centre of a shelf
    expect(path).not.toBeNull();
    const end = path![path!.length - 1];
    expect(nav.isPointFree(end)).toBe(true);
  });
});

describe("AnimationFSM (GAME-05)", () => {
  it("rejects illegal transitions and reports expiry", () => {
    const f = new AnimationFSM();
    expect(f.go("show")).toBe(false);
    expect(f.go("walk")).toBe(true);
    expect(f.tick(26)).toBe(true);
    f.force("idle");
    expect(f.tick(1000)).toBe(false);
  });
});

function action(id: string, avatar: string, product = "TRA_CA_GAI_LEO", shelfId = "KE_02", stand = 1): CharacterAction {
  return {
    type: "CHARACTER_ACTION", command_id: id, avatar_id: avatar, product_id: product, shelf_id: shelfId,
    slot_id: "S2", stand_index: stand, action: "WALK_PICKUP_SHOW", parameters: { show_seconds: 8, camera_priority: 50 },
  };
}

function run(engine: GameEngine, seconds: number, onFrame?: () => void) {
  for (let t = 0; t < seconds; t += 1 / 30) {
    engine.step(1 / 30);
    onFrame?.();
  }
}

describe("WALK_PICKUP_SHOW (C1, H3)", () => {
  function setup() {
    const sent: ClientGameMessage[] = [];
    const e = new GameEngine((m) => sent.push(m));
    e.applySnapshot({
      type: "SNAPSHOT", sequence: 0, session_id: "demo_x", live_status: "Đã kết nối", is_demo: true, layout: LAYOUT,
      avatars: [], active_commands: [], camera: { mode: "overview" }, settings: { show_seconds: 8 },
    });
    e.handle({ type: "AVATAR_SPAWN", sequence: 1, avatar: { avatar_id: "av_1", nickname: "lananh88", unique_id: "lananh88", appearance_seed: 7, is_demo: true } });
    return { e, sent };
  }

  it("walks to KE_02, picks the right box into its own hand, shows, returns, completes", () => {
    const { e, sent } = setup();
    e.handle({ ...action("cmd_1", "av_1"), sequence: 2 });
    e.handle({ type: "CAMERA_FOCUS", sequence: 3, mode: "follow", avatar_id: "av_1", command_id: "cmd_1" });
    const phases = new Set<string>();
    let showcased: string | null = null;
    run(e, 40, () => {
      const a = e.avatars.get("av_1")!;
      phases.add(a.phase);
      if (a.phase === "show") {
        expect(a.held?.productId).toBe("TRA_CA_GAI_LEO");
        expect(a.held?.mode).toBe("inHand");
        showcased = e.showcase()?.product.id ?? null;
      }
    });
    for (const p of ["to_stand", "inspect", "pickup", "hold", "show", "return"]) expect(phases.has(p)).toBe(true);
    expect(showcased).toBe("TRA_CA_GAI_LEO");
    const types = sent.filter((m) => "command_id" in m && m.command_id === "cmd_1").map((m) => m.type);
    expect(types[0]).toBe("ACK");
    expect(types).toContain("ACTION_STARTED");
    expect(types[types.length - 1]).toBe("ACTION_COMPLETED");
    const a = e.avatars.get("av_1")!;
    expect(a.held).toBeNull();
    expect(a.cmd).toBeNull();
  });

  it("duplicate delivery is idempotent (re-ACK, no second run)", () => {
    const { e, sent } = setup();
    e.handle({ ...action("cmd_1", "av_1"), sequence: 2 });
    e.handle({ ...action("cmd_1", "av_1"), sequence: 3 });
    expect(sent.filter((m) => m.type === "ACTION_STARTED").length).toBe(1);
    expect(sent.filter((m) => m.type === "ACK").length).toBe(2);
  });

  it("preempt shortens the show and still returns the box first", () => {
    const { e, sent } = setup();
    e.handle({ ...action("cmd_1", "av_1"), sequence: 2 });
    let tShow = -1;
    let t = 0;
    for (; t < 40; t += 1 / 30) {
      e.step(1 / 30);
      const a = e.avatars.get("av_1")!;
      if (a.phase === "show" && tShow < 0) {
        tShow = t;
        e.handle({ type: "PREEMPT", sequence: 3, command_id: "cmd_1", avatar_id: "av_1" });
      }
      if (sent.some((m) => m.type === "ACTION_COMPLETED")) break;
    }
    expect(t - tShow).toBeLessThan(2.5); // not the full 8 s show
    const done = sent.find((m) => m.type === "ACTION_COMPLETED") as { reason?: string };
    expect(done.reason).toBe("preempted");
    expect(e.avatars.get("av_1")!.held).toBeNull();
  });

  it("RESET_AVATAR never leaves a box stuck in the hand", () => {
    const { e } = setup();
    e.handle({ ...action("cmd_1", "av_1"), sequence: 2 });
    run(e, 30, () => {
      const a = e.avatars.get("av_1")!;
      if (a.held?.mode === "inHand") e.handle({ type: "RESET_AVATAR", sequence: 9, avatar_id: "av_1", command_id: "cmd_1", reason: "action_timeout" });
    });
    expect(e.avatars.get("av_1")!.held).toBeNull();
  });

  it("unknown shelf fails fast with a reason", () => {
    const { e, sent } = setup();
    e.handle({ ...action("cmd_x", "av_1", "TRA_CA_GAI_LEO", "KE_99"), sequence: 2 });
    expect(sent.some((m) => m.type === "ACTION_FAILED" && m.reason === "unknown_shelf")).toBe(true);
  });

  it("snapshot after reload does not duplicate avatars (T18)", () => {
    const { e } = setup();
    const snap = {
      type: "SNAPSHOT" as const, sequence: 10, session_id: "demo_x", live_status: "Đã kết nối", is_demo: true, layout: LAYOUT,
      avatars: [{ avatar_id: "av_1", nickname: "lananh88", unique_id: "lananh88", appearance_seed: 7, is_demo: true }],
      active_commands: [action("cmd_1", "av_1")], camera: { mode: "overview" as const }, settings: { show_seconds: 8 },
    };
    e.applySnapshot(snap);
    e.applySnapshot(snap);
    expect(e.avatars.size).toBe(1);
    expect(e.avatars.get("av_1")!.cmd?.command_id).toBe("cmd_1");
  });
});

describe("SequenceTracker (snapshot + sequence)", () => {
  it("buffers before snapshot, applies in order, ignores old, resyncs on gap", () => {
    const t = new SequenceTracker();
    expect(t.decide(11, "a")).toBe("buffer");
    expect(t.decide(9, "old")).toBe("buffer");
    expect(t.onSnapshot(10)).toEqual(["a"]);
    expect(t.decide(11, "dup")).toBe("ignore");
    expect(t.decide(12, "b")).toBe("apply");
    expect(t.decide(14, "gap")).toBe("resync");
    expect(t.haveSnapshot).toBe(false);
  });
});

describe("nickname labels (GAME-09)", () => {
  it("truncates and strips control characters; markup stays literal text", () => {
    expect(sanitizeLabel("a".repeat(30))).toBe("a".repeat(15) + "…");
    expect(sanitizeLabel("<b>x</b>\u0007")).toBe("<b>x</b>");
    expect(sanitizeLabel("   ")).toBe("khách");
  });
});

describe("rotated shelves (editor)", () => {
  function rshelf(code: string, x: number, z: number, deg: number, productSlot1: string | null) {
    const rot = (deg * Math.PI) / 180;
    const [fx, fz, rx, rz] = [Math.sin(rot), Math.cos(rot), Math.cos(rot), -Math.sin(rot)];
    const front = 0.3 + 0.55;
    return {
      code, name: code, transform: { x, z, rot, w: 2.4, d: 0.6, h: 1.6 },
      stand_positions: [-0.7, 0, 0.7].map((dx) => ({ x: x + fx * front + rx * dx, z: z + fz * front + rz * dx })),
      wait_positions: [-1, 1].map((sg) => ({ x: x + fx * front + rx * sg * 1.75, z: z + fz * front + rz * sg * 1.75 })),
      slots: [-0.7, 0, 0.7].map((dx, i) => ({ code: `S${i + 1}`, product_id: i === 0 ? productSlot1 : null, local: { x: dx, y: 0.55, z: 0.18 } })),
    };
  }

  for (const deg of [90, 180, 270]) {
    it(`walks to a shelf rotated ${deg}°, faces it, then presents the box away from it`, () => {
      const layout: StoreLayout = { ...LAYOUT, version: 2, shelves: [rshelf("KE_R", 0, 0, deg, "TRA_CA_GAI_LEO"), ...LAYOUT.shelves.filter((s) => s.code !== "KE_03" && s.code !== "KE_04")] };
      const nav = new NavGrid(layout);
      // the shelf body itself is not walkable, its stand points are
      expect(nav.isPointFree({ x: 0, z: 0 })).toBe(false);
      for (const p of layout.shelves[0].stand_positions) expect(nav.isPointFree(p)).toBe(true);
      const sent: ClientGameMessage[] = [];
      const e = new GameEngine((m) => sent.push(m));
      e.applySnapshot({ type: "SNAPSHOT", sequence: 0, session_id: "s", live_status: "Đã kết nối", is_demo: true, layout, avatars: [{ avatar_id: "a", nickname: "a", unique_id: "a", appearance_seed: 1, is_demo: true }], active_commands: [], camera: { mode: "overview" }, settings: { show_seconds: 2 } });
      e.handle({ ...action("c1", "a", "TRA_CA_GAI_LEO", "KE_R", 1), parameters: { show_seconds: 2, camera_priority: 50 }, sequence: 1, slot_id: "S1" });
      const rot = (deg * Math.PI) / 180;
      const norm = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
      let sawInspectFacing = false;
      let sawShowFacing = false;
      run(e, 40, () => {
        const a = e.avatars.get("a")!;
        if (a.phase === "pickup") sawInspectFacing ||= Math.abs(norm(a.yaw - (rot + Math.PI))) < 0.3;
        if (a.phase === "show" && a.fsm.elapsed > 1) {
          sawShowFacing ||= Math.abs(norm(a.yaw - rot)) < 0.3;
          expect(a.held?.productId).toBe("TRA_CA_GAI_LEO");
        }
      });
      expect(sawInspectFacing).toBe(true);
      expect(sawShowFacing).toBe(true);
      expect(sent.some((m) => m.type === "ACTION_COMPLETED")).toBe(true);
    });
  }
});

describe("label layout (GAME-09)", () => {
  it("keeps the nearest label, lifts the next, hides when there is no room", async () => {
    const { layoutLabels } = await import("./labelLayout");
    const box = (id: string, depth: number) => ({ id, x: 100, y: 200, w: 80, h: 20, depth });
    const out = layoutLabels([box("far", 9), box("near", 3), box("mid", 5), box("x", 7), box("y", 8)]);
    expect(out.get("near")).toEqual({ lift: 0, visible: true });
    expect(out.get("mid")).toEqual({ lift: 1, visible: true });
    expect(out.get("x")).toEqual({ lift: 2, visible: true });
    expect(out.get("y")!.visible).toBe(false);
    const apart = layoutLabels([box("a", 1), { ...box("b", 2), x: 400 }]);
    expect(apart.get("b")).toEqual({ lift: 0, visible: true });
  });
});

describe("viewer leaves", () => {
  it("waves goodbye, walks to the door, then is removed — even mid-action, without a stuck box", () => {
    const e = new GameEngine(() => undefined);
    e.applySnapshot({ type: "SNAPSHOT", sequence: 0, session_id: "s", live_status: "Đã kết nối", is_demo: false, layout: LAYOUT, avatars: [{ avatar_id: "a", nickname: "a", unique_id: "a", appearance_seed: 1, is_demo: false }], active_commands: [], camera: { mode: "overview" }, settings: { show_seconds: 8 } });
    e.handle({ ...action("c1", "a"), sequence: 1 });
    run(e, 6); // somewhere in the walk / pickup
    e.handle({ type: "AVATAR_EXIT", sequence: 2, avatar_id: "a", reason: "idle" });
    const a = e.avatars.get("a")!;
    expect(a.phase).toBe("goodbye");
    expect(a.state).toBe("wave");
    expect(a.held).toBeNull();
    run(e, 0.6);
    expect(e.avatars.get("a")?.phase).toBe("goodbye");
    run(e, 30);
    expect(e.avatars.has("a")).toBe(false);
  });
});
