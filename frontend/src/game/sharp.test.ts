// "Nét nhất" rendering and chat that is only read aloud.

import { describe, expect, it } from "vitest";
import { isChatClip } from "./SpeechPlayer";
import { ultraDpr } from "./World";

describe("Nét nhất (ultra) quality", () => {
  it("draws twice the window's pixels, at most 3840 px on the long side, never below the screen", () => {
    expect(ultraDpr(1080, 1920, 1)).toBe(2); // 2160 × 3840, scaled down by the browser
    expect(ultraDpr(540, 960, 1)).toBe(2);
    expect(ultraDpr(720, 1280, 1.5)).toBe(3); // 1080 × 1920 window on a 150 % screen → 2160 × 3840
    expect(ultraDpr(1440, 2560, 1.5)).toBe(1.5); // already huge: the screen's own density
    expect(ultraDpr(2160, 3840, 1)).toBe(1);
  });
});

describe("chat is only read aloud", () => {
  it("comments, questions and the replies to them are chat; poems, greetings and stage calls are not", () => {
    for (const k of ["comment", "question", "answer"] as const) expect(isChatClip({ kind: k })).toBe(true);
    for (const k of ["poem", "story", "stage", "welcome", "greeting", "product", "test"] as const) expect(isChatClip({ kind: k })).toBe(false);
  });
});
