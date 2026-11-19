import { describe, expect, it } from "vitest";
import { centreOnPhone, keepOnPhone, PHONE_SIDE, PHONE_ZOOM } from "./phoneSafe";

describe("what phones show of the 9:16 LIVE picture", () => {
  it("covers phones up to 9:20.5 (they cut both sides of the picture)", () => {
    const cut = (tall: number) => (1 - 9 / tall / (9 / 16)) / 2;
    expect(cut(19.5)).toBeLessThan(PHONE_SIDE);
    expect(cut(20.5)).toBeLessThanOrEqual(PHONE_SIDE + 1e-9);
  });
  it("a box dragged to an edge is moved just inside what phones show", () => {
    expect(keepOnPhone(0, 0.3)).toBeCloseTo(0.11);
    expect(keepOnPhone(0.8, 0.3)).toBeCloseTo(0.59); // right edge at 0.89
    expect(keepOnPhone(0.4, 0.3)).toBeCloseTo(0.4); // already inside: unchanged
    expect(keepOnPhone(0, 0.9)).toBeCloseTo(0.05); // wider than the middle: centred
  });
  it("the owner's bubble stays inside too", () => {
    expect(centreOnPhone(0.05, 0.5)).toBeCloseTo(0.36);
    expect(centreOnPhone(0.97, 0.5)).toBeCloseTo(0.64);
    expect(centreOnPhone(0.5, 0.5)).toBeCloseTo(0.5);
  });
  it("the camera zooms out so the shop fits the middle", () => {
    expect(PHONE_ZOOM).toBeGreaterThan(0.75);
    expect(PHONE_ZOOM).toBeLessThan(1 - 2 * PHONE_SIDE + 0.03);
  });
});
