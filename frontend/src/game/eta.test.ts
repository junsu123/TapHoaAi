import { describe, expect, it } from "vitest";
import { etaText } from "./LiveOverlay";

describe("waiting time on the stage board", () => {
  it("rounds like people talk", () => {
    expect(etaText(4)).toBe("~10 giây");
    expect(etaText(37)).toBe("~40 giây");
    expect(etaText(95)).toBe("~2 phút");
    expect(etaText(300)).toBe("~5 phút");
  });
});
