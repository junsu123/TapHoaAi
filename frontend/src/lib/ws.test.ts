import { describe, expect, it } from "vitest";
import { SequenceTracker, unpackFrame } from "./ws";

describe("frames from the server", () => {
  it("unpacks a BATCH frame into its messages, in order", () => {
    const frame = JSON.stringify({ type: "BATCH", messages: [{ type: "A", sequence: 1 }, { type: "B", sequence: 2 }] });
    expect(unpackFrame(frame).map((m) => m.type)).toEqual(["A", "B"]);
    expect(unpackFrame(JSON.stringify({ type: "PONG" }))).toEqual([{ type: "PONG" }]);
    expect(unpackFrame("not json")).toEqual([]);
    expect(unpackFrame(JSON.stringify({ type: "BATCH" }))).toEqual([]);
  });

  it("a batch keeps the sequence rules (gap → resync)", () => {
    const t = new SequenceTracker();
    t.onSnapshot(10);
    const batch = unpackFrame<{ type: string; sequence: number }>(
      JSON.stringify({ type: "BATCH", messages: [11, 12, 14].map((s) => ({ type: "X", sequence: s })) }),
    );
    expect(batch.map((m) => t.decide(m.sequence, m))).toEqual(["apply", "apply", "resync"]);
  });
});
