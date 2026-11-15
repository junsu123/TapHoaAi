import { describe, expect, it } from "vitest";
import { GUEST_SIT_SECONDS, TeaHouse, teaSpot, type TeaVisitor } from "./teahouse";
import type { StoreLayout } from "../types/protocol";

const LAYOUT = {
  version: 1,
  store: { width: 12, depth: 16, door: { x: 0, z: 8 }, counter: { x: 0, z: -6.6, w: 3.2, d: 0.8 } },
  shelves: [],
  products: [],
} as unknown as StoreLayout;

class Visitor implements TeaVisitor {
  removed = false;
  busy = false;
  phase = "none";
  left = false;
  visitTea() {
    this.phase = "to_tea";
    return true;
  }
  leaveTea() {
    this.left = true;
    this.phase = "tea_up";
  }
}

const run = (h: TeaHouse, seconds: number, spot = teaSpot(LAYOUT)) => {
  for (let t = 0; t < seconds; t += 0.05) h.update(0.05, spot);
};

describe("tea house", () => {
  it("puts the tea table in the centre aisle, owner and guest facing each other", () => {
    const s = teaSpot(LAYOUT);
    expect(s.table.x).toBe(0);
    expect(s.table.z).toBeGreaterThan(-6.2 + 1.5);
    expect(s.owner.x).toBeLessThan(s.table.x);
    expect(s.guest.x).toBeGreaterThan(s.table.x);
    expect(Math.sign(s.ownerYaw)).toBe(-Math.sign(s.guestYaw));
    expect(s.guestApproach.z).toBeGreaterThan(s.obstacle.maxZ + 0.3);
  });

  it("greeting: stands up, bows, then sits back down to brew; bubble shows the text", () => {
    const h = new TeaHouse(() => undefined);
    h.greet("Xin chào quý khách Lan đã vào quán!");
    expect(h.bubble?.text).toContain("Lan");
    expect(h.pose).toBe("rise");
    const seen = new Set<string>();
    for (let t = 0; t < 6; t += 0.05) {
      h.update(0.05, null);
      seen.add(h.pose);
      if (h.pose === "bow") expect(h.bowAngle()).toBeGreaterThanOrEqual(0);
    }
    expect([...seen]).toEqual(expect.arrayContaining(["bow", "stand", "sit", "brew"]));
    expect(h.pose).toBe("brew");
    expect(h.bubble).toBeNull();
  });

  it("gift: the giver sits opposite, is served tea, leaves after a while; the next one follows", () => {
    const a = new Visitor();
    const b = new Visitor();
    const h = new TeaHouse((id) => (id === "a" ? a : id === "b" ? b : undefined));
    h.invite("a", "Lan Anh", "Mời Lan Anh dùng trà ạ!");
    h.invite("b", "Minh", "Mời Minh dùng trà ạ!");
    run(h, 0.1);
    expect(h.guest?.avatarId).toBe("a");
    expect(a.phase).toBe("to_tea");
    a.phase = "tea_sit";
    run(h, 0.1);
    expect(h.bubble?.text).toBe("Mời Lan Anh dùng trà ạ!");
    expect(h.pose).toBe("serve");
    run(h, 3);
    expect(h.guestCupFull).toBe(true);
    run(h, GUEST_SIT_SECONDS);
    expect(a.left).toBe(true);
    expect(h.guest?.avatarId).toBe("b");
  });

  it("no Chibi on screen: just the bubble", () => {
    const h = new TeaHouse(() => undefined);
    h.invite(null, "Hoa", "Mời Hoa dùng trà ạ!");
    expect(h.bubble?.kind).toBe("tea");
    expect(h.guest).toBeNull();
  });
});
