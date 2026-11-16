// Chibi levels on the game side: level from the spawn, level-up celebration, progress bar.

import { describe, expect, it } from "vitest";
import type { AvatarInfo } from "../types/protocol";
import { DEFAULT_SCENE } from "../types/protocol";
import { GameEngine } from "./GameEngine";
import { LAYOUT } from "./testFixtures";

function engine() {
  const e = new GameEngine(() => undefined);
  e.setLayout(LAYOUT);
  e.setScene({ ...DEFAULT_SCENE });
  return e;
}
const info = (id: string, level?: number): AvatarInfo => ({ avatar_id: id, nickname: id, unique_id: id, appearance_seed: 7, is_demo: true, level });

describe("Chibi levels (watch time)", () => {
  it("a Chibi that comes in later wears its level straight away", () => {
    const e = engine();
    e.handle({ type: "AVATAR_SPAWN", sequence: 1, avatar: info("a", 2) });
    e.handle({ type: "AVATAR_SPAWN", sequence: 2, avatar: info("b") });
    expect(e.avatars.get("a")!.level).toBe(2);
    expect(e.avatars.get("b")!.level).toBe(0);
  });

  it("levels up with a star and a little cheer; a name change keeps the level", () => {
    const e = engine();
    e.handle({ type: "AVATAR_SPAWN", sequence: 1, avatar: info("a") });
    for (let i = 0; i < 40; i++) e.step(0.05);
    const a = e.avatars.get("a")!;
    e.handle({ type: "AVATAR_LEVEL", sequence: 2, avatar_id: "a", level: 1, up: true, item: "nón lá" });
    expect(a.level).toBe(1);
    expect(a.emote?.icon).toBe("★");
    expect(a.sinceLevelUp).toBeLessThan(0.5);
    e.step(0.1);
    expect(["CHEER", "cheer"].some((k) => a.state.toLowerCase().includes(k.toLowerCase())) || a.history.includes("DIRECT_CHEER") || a.phase === "direct").toBe(true);
    e.handle({ type: "AVATAR_UPDATE", sequence: 3, avatar: { ...info("a"), nickname: "a mới", level: 1 } });
    expect(a.level).toBe(1);
  });

  it("progress towards the next level (the bar shows from half way)", () => {
    const e = engine();
    e.handle({ type: "AVATAR_SPAWN", sequence: 1, avatar: info("a", 1) });
    e.handle({ type: "LEVEL_PROGRESS", sequence: 2, items: [["a", 1, 0.75], ["gone", 2, 0.1]] });
    expect(e.avatars.get("a")!.levelProgress).toBe(0.75);
    e.handle({ type: "LEVEL_PROGRESS", sequence: 3, items: [["a", 1, null]] });
    expect(e.avatars.get("a")!.levelProgress).toBeNull();
  });
});
