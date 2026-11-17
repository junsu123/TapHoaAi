import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE } from "../types/protocol";
import { isMoved, OVERLAY_ITEMS, placePatch, spotOf } from "./overlayItems";

describe("overlay items", () => {
  it("every box has an on/off switch in the settings; all but the LED wall screen and the owner's bubble can be placed", () => {
    for (const it of OVERLAY_ITEMS) {
      expect(typeof DEFAULT_SCENE[it.show]).toBe("boolean");
      expect(DEFAULT_SCENE[it.show]).toBe(true);
      if (it.place) {
        expect(DEFAULT_SCENE[it.place.x]).toBeNull();
        expect(DEFAULT_SCENE[it.place.scale]).toBe(1);
      }
    }
    expect(OVERLAY_ITEMS.filter((i) => !i.place).map((i) => i.key)).toEqual(["banner", "owner"]);
    expect(new Set(OVERLAY_ITEMS.map((i) => i.key)).size).toBe(OVERLAY_ITEMS.length);
  });

  it("reads and writes a box's spot", () => {
    const cfg = { ...DEFAULT_SCENE, ...placePatch("caption", 0.1, 0.2, 0.8) };
    expect(cfg.caption_x).toBe(0.1);
    expect(spotOf(cfg, "caption")).toEqual({ x: 0.1, y: 0.2, scale: 0.8 });
    expect(isMoved(cfg, "caption")).toBe(true);
    expect(isMoved(cfg, "board")).toBe(false);
    expect(placePatch("banner", 0.1, 0.1, 1)).toEqual({}); // the LED screen stays on the wall
    expect(placePatch("owner", 0.1, 0.1, 1)).toEqual({});
    const back = { ...cfg, ...placePatch("caption", null, null, 1) };
    expect(isMoved(back, "caption")).toBe(false);
  });
});
