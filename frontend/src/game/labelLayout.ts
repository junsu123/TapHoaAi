// Screen-space nickname layout (GAME-09 "chống đè lên nhau"): nearer labels win; a label
// that would overlap is lifted up to MAX_LIFT steps, otherwise hidden for this frame.

export interface LabelBox {
  id: string;
  x: number; // screen centre x (px)
  y: number; // screen bottom y (px, grows downward)
  w: number;
  h: number;
  depth: number; // distance to camera — nearer labels are placed first
}

export interface LabelPlacement {
  lift: number; // how many label heights to raise
  visible: boolean;
}

export const MAX_LIFT = 2;
const PAD = 2;

export function layoutLabels(boxes: LabelBox[]): Map<string, LabelPlacement> {
  const out = new Map<string, LabelPlacement>();
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const sorted = [...boxes].sort((a, b) => a.depth - b.depth);
  for (const b of sorted) {
    let done = false;
    for (let k = 0; k <= MAX_LIFT && !done; k++) {
      const y1 = b.y - k * (b.h + PAD);
      const r = { x0: b.x - b.w / 2 - PAD, x1: b.x + b.w / 2 + PAD, y0: y1 - b.h, y1 };
      if (!placed.some((p) => r.x0 < p.x1 && p.x0 < r.x1 && r.y0 < p.y1 && p.y0 < r.y1)) {
        placed.push(r);
        out.set(b.id, { lift: k, visible: true });
        done = true;
      }
    }
    if (!done) out.set(b.id, { lift: 0, visible: false });
  }
  return out;
}
