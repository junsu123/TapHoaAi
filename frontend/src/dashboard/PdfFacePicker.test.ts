import { describe, expect, it } from "vitest";
import { BOX_FACES, faceSizePt, initialFrames, snap } from "./PdfFacePicker";

const PT = 72 / 2.54;
const cm = { w: 12, h: 17, d: 5.2 };
const page = (index: number, wcm: number, hcm: number) => ({ index, width_pt: wcm * PT, height_pt: hcm * PT, preview_url: "" });

describe("PDF face picker", () => {
  it("sizes faces from the real box size", () => {
    expect(faceSizePt("front", cm).map((v) => +(v / PT).toFixed(2))).toEqual([12, 17]);
    expect(faceSizePt("left", cm).map((v) => +(v / PT).toFixed(2))).toEqual([5.2, 17]);
    expect(faceSizePt("top", cm).map((v) => +(v / PT).toFixed(2))).toEqual([12, 5.2]);
  });

  it("lays out a standard dieline on the printed area", () => {
    const content = { x0: 2 * PT, y0: 2 * PT, x1: 40 * PT, y1: 29.4 * PT };
    const f = initialFrames([page(0, 44, 31.4)], cm, content);
    expect(f.left.x).toBeCloseTo(2 * PT);
    expect(f.front.x).toBeCloseTo(f.left.x + f.left.w);
    expect(f.right.x).toBeCloseTo(f.front.x + f.front.w);
    expect(f.back.x).toBeCloseTo(f.right.x + f.right.w);
    expect(f.top.y + f.top.h).toBeCloseTo(f.front.y);
    expect(f.bottom.y).toBeCloseTo(f.front.y + f.front.h);
    expect(BOX_FACES.every((k) => f[k].on && f[k].page === 0)).toBe(true);
  });

  it("maps one page per face by size, turning sideways pages", () => {
    const pages = [page(0, 12, 17), page(1, 12, 17), page(2, 5.2, 17), page(3, 17, 5.2), page(4, 12, 5.2), page(5, 12, 5.2)];
    const f = initialFrames(pages, cm, null);
    expect([f.front.page, f.back.page, f.left.page, f.right.page, f.top.page, f.bottom.page]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(f.right.rotate).toBe(90);
    expect(f.front.rotate).toBe(0);
  });

  it("snaps a dragged frame to a neighbour's fold line", () => {
    const f = initialFrames([page(0, 44, 31.4)], cm, { x0: 2 * PT, y0: 2 * PT, x1: 40 * PT, y1: 29.4 * PT });
    const target = f.front.x + f.front.w;
    const s = snap("right", f.right, target + 3, f.right.y - 4, f, 6);
    expect(s.x).toBeCloseTo(target);
    expect(s.y).toBeCloseTo(f.front.y);
    const far = snap("right", f.right, target + 40, f.right.y + 40, f, 6);
    expect(far.x).toBeCloseTo(target + 40);
  });
});
