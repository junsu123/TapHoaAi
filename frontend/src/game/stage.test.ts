// Dance stage (client): where it stands, a Chibi's turn on it, and the owner's talking bubble.

import { describe, expect, it } from "vitest";
import type { AvatarInfo, ClientGameMessage } from "../types/protocol";
import { DEFAULT_SCENE } from "../types/protocol";
import { GameEngine } from "./GameEngine";
import { stageSpot } from "./stage";
import { bubbleText, TeaHouse } from "./teahouse";
import { LAYOUT } from "./testFixtures";

function engineWith(n: number) {
  const sent: ClientGameMessage[] = [];
  const e = new GameEngine((m) => sent.push(m));
  e.setLayout(LAYOUT);
  e.setScene({ ...DEFAULT_SCENE });
  for (let i = 0; i < n; i++) {
    const info: AvatarInfo = { avatar_id: `av_${i}`, nickname: `khach${i}`, unique_id: `khach${i}`, appearance_seed: 4000 + i * 7919, is_demo: true };
    e.handle({ type: "AVATAR_SPAWN", sequence: i + 1, avatar: info });
  }
  return { e, sent };
}
const run = (e: GameEngine, s: number, f?: () => void) => {
  for (let t = 0; t < s; t += 0.05) {
    e.step(0.05);
    f?.();
  }
};

describe("the stage in the middle of the shop (default)", () => {
  it("stands in the centre aisle, in the middle of the picture, with a walkway on both sides", () => {
    const { e } = engineWith(0);
    const s = e.stageSpot!;
    expect(s.shape).toBe("round");
    expect(s.placed).toBe("center");
    expect(s.center.x).toBe(0);
    // where the tea table stood before: the middle of the overview picture
    expect(s.center.z).toBeGreaterThan(-2);
    expect(s.center.z).toBeLessThan(0.5);
    expect(e.spot!.table.z).toBeLessThan(s.center.z - 2); // the tea table moved back towards the counter
    const nav = e.nav!;
    expect(nav.isPointFree(s.approach)).toBe(true);
    expect(nav.isPointFree(s.top)).toBe(false);
    // people still walk past it, left and right of the stage
    for (const x of [-1.375, 1.375]) expect(nav.isPointFree({ x, z: s.center.z })).toBe(true);
    // the door still reaches every shelf, the tea table and the counter
    const door = LAYOUT.store.door;
    for (const sh of LAYOUT.shelves) for (const p of [...sh.stand_positions, ...sh.wait_positions]) expect(nav.findPath(door, p), `${sh.code}`).not.toBeNull();
    expect(nav.findPath(door, e.spot!.guestApproach)).not.toBeNull();
    // clear of the tea table
    const t = e.spot!.obstacle;
    expect(s.obstacle.minZ).toBeGreaterThan(t.maxZ + 0.5);
  });

  it("a shop layout with no room in the middle puts it at the front corner", () => {
    const crowded = {
      ...LAYOUT,
      shelves: [...LAYOUT.shelves, ...[-2, 0.25, 2.25, 4].map((z, i) => ({ ...LAYOUT.shelves[0], code: `MID_${i}`, transform: { ...LAYOUT.shelves[0].transform, x: 0, z, w: 1.2 }, stand_positions: [], wait_positions: [] }))],
    };
    const s = stageSpot(crowded, "center");
    expect(s.placed).toBe("right");
    expect(s.shape).toBe("box");
  });
});

describe("the stage in the shop", () => {
  it("stands in front, clear of shelves and the door, with free steps", () => {
    for (const side of ["right", "left"] as const) {
      const s = stageSpot(LAYOUT, side);
      const o = s.obstacle;
      expect(o.maxX).toBeLessThan(LAYOUT.store.width / 2);
      expect(o.minX).toBeGreaterThan(-LAYOUT.store.width / 2);
      expect(o.maxZ).toBeLessThan(LAYOUT.store.depth / 2);
      expect(Math.min(Math.abs(o.minX), Math.abs(o.maxX))).toBeGreaterThan(1.2); // the door path stays open
      for (const sh of LAYOUT.shelves) expect(o.minZ).toBeGreaterThan(sh.transform.z + sh.transform.d / 2 + 0.8);
      const { e } = engineWith(0);
      e.setScene({ ...DEFAULT_SCENE, stage_side: side });
      expect(e.nav!.isPointFree(s.approach)).toBe(true);
      expect(e.nav!.isPointFree(s.top)).toBe(false); // the platform itself is not walkable
    }
  });

  it("their turn: walks over, climbs up, dances a routine, bows, steps down, lives on", () => {
    const { e, sent } = engineWith(3);
    run(e, 5);
    const a = e.avatars.get("av_1")!;
    e.handle({ type: "STAGE_PERFORM", sequence: 50, avatar_id: "av_1", token: "st1", name: "khach1", seconds: 10 });
    expect(a.topState).toBe("NAVIGATING");
    const moves = new Set<string>();
    let maxY = 0;
    run(e, 16, () => {
      if (a.phase === "stage_dance") moves.add(a.state);
      maxY = Math.max(maxY, a.elevation);
    });
    const on = sent.find((m) => m.type === "STAGE_PROGRESS" && m.phase === "on_stage");
    expect(on).toBeTruthy();
    expect(a.phase).toBe("stage_dance");
    expect(a.topState).toBe("PLAYING");
    expect(maxY).toBeCloseTo(e.stageSpot!.height, 2);
    expect(moves.size).toBeGreaterThanOrEqual(3); // dance, spin, pose…
    // a viewer's "nhảy" meanwhile does not interrupt the show
    e.handle({ type: "SOCIAL_EFFECT", sequence: 51, kind: "wave", avatar_id: "av_1" });
    expect(a.phase).toBe("stage_dance");
    e.handle({ type: "STAGE_END", sequence: 52, avatar_id: "av_1", token: "st1" });
    expect(a.phase).toBe("stage_down");
    run(e, 8);
    expect(a.onStage).toBe(false);
    expect(a.elevation).toBe(0);
    run(e, 10);
    expect(a.history).toEqual(expect.arrayContaining(["STAGE_DANCE"]));
  });

  it("a Chibi that cannot get there tells the server (the line goes on)", () => {
    const { e, sent } = engineWith(1);
    e.handle({ type: "STAGE_PERFORM", sequence: 9, avatar_id: "nobody", token: "st9", name: "x", seconds: 10 });
    expect(sent.some((m) => m.type === "STAGE_PROGRESS" && m.token === "st9" && m.phase === "failed")).toBe(true);
  });

  it("nobody walks through the stage (60 s of shop life)", () => {
    const { e } = engineWith(12);
    const o = e.stageSpot!.obstacle;
    run(e, 60, () => {
      for (const a of e.avatars.values()) {
        if (a.onStage) continue;
        const inside = a.pos.x > o.minX + 0.1 && a.pos.x < o.maxX - 0.1 && a.pos.z > o.minZ + 0.1 && a.pos.z < o.maxZ - 0.1;
        expect(inside, `${a.info.nickname} on the platform at ${a.pos.x.toFixed(2)},${a.pos.z.toFixed(2)}`).toBe(false);
      }
    });
  });
});

describe("the owner talks", () => {
  it("every voice line shows in the bubble while it plays", () => {
    const t = new TeaHouse(() => undefined);
    t.talk("Dạ cảm ơn Lan nhiều ạ!", "answer");
    expect(t.talking).toBe(true);
    expect(t.bubble?.kind).toBe("talk");
    t.line("Mời bạn An lên sân khấu!", "stage"); // a short line waits for the voice to finish
    expect(t.bubble?.text).toBe("Dạ cảm ơn Lan nhiều ạ!");
    t.update(1, null);
    t.stopTalk(); // … then shows right after
    expect(t.bubble?.text).toBe("Mời bạn An lên sân khấu!");
    t.update(6, null);
    expect(t.bubble).toBeNull();
    t.talk("Câu khác", "answer");
    t.stopTalk();
    t.update(2, null);
    expect(t.bubble).toBeNull(); // the voice line fades shortly after it ends
  });

  it("poems keep their lines; a story shows its first sentence", () => {
    const poem = "Tặng Lan một bài thơ nhỏ:\nDòng một,\nDòng hai.\nDòng ba,\nDòng bốn.";
    expect(bubbleText(poem, "poem").split("\n")).toHaveLength(5);
    const story = "Chủ quán kể cả nhà nghe một chuyện nhỏ nha.\nChuyện con mèo canh quán. Quán có một chú mèo vàng.";
    expect(bubbleText(story, "story")).toBe("📖 Chuyện con mèo canh quán.");
    expect(bubbleText("x ".repeat(200), "talk").length).toBeLessThanOrEqual(141);
  });
});
