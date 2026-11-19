import { describe, expect, it } from "vitest";
import { frameTooWide } from "./frame";

describe("LIVE frame shape", () => {
  it("portrait 9:16 (and a little wider, which the game page fills) is fine", () => {
    expect(frameTooWide([1080, 1920])).toBe(false);
    expect(frameTooWide([720, 1280])).toBe(false);
    expect(frameTooWide([1064, 1881])).toBe(false); // window border / rounding
    expect(frameTooWide([1080, 2400])).toBe(false); // taller: the game fills it
    expect(frameTooWide(null)).toBe(false);
  });
  it("wider frames show dark bars both sides and do not fit TikTok's portrait frame", () => {
    expect(frameTooWide([1920, 1080])).toBe(true); // Link source without its own size, F11 on a landscape screen
    expect(frameTooWide([1080, 1050])).toBe(true); // 1080 × 1920 window cut to the screen height
    expect(frameTooWide([960, 1040])).toBe(true); // snapped to half the screen
  });
});
