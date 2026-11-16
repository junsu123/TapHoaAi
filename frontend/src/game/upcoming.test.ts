import { describe, expect, it } from "vitest";
import { whenText } from "./LiveOverlay";

describe("“Sắp diễn ra” countdowns", () => {
  const now = 1_700_000_000_000;
  it("reads like people talk", () => {
    expect(whenText(null, now)).toBe("đang diễn ra");
    expect(whenText(now + 3000, now)).toBe("sắp bắt đầu");
    expect(whenText(now + 45_000, now)).toBe("45 giây");
    expect(whenText(now + 61_000, now)).toBe("2 phút");
    expect(whenText(now + 4 * 60_000, now)).toBe("4 phút");
    expect(whenText(now + 2 * 3600_000, now, "22:10")).toBe("22:10");
  });
});
