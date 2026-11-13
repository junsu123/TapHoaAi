// Grid A* over the static store map (GAME-04). Shelves, counter and walls are obstacles
// inflated by the character radius, so a path can never pass through a shelf.

import type { Point2, StoreLayout } from "../types/protocol";

export const CELL = 0.25;
export const AGENT_RADIUS = 0.3;
const WALL_MARGIN = 0.35;

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minZ: number;
  readonly blocked: Uint8Array;
  readonly obstacles: Rect[];

  constructor(layout: StoreLayout) {
    const w = layout.store.width;
    const d = layout.store.depth;
    this.minX = -w / 2;
    this.minZ = -d / 2;
    this.cols = Math.round(w / CELL);
    this.rows = Math.round(d / CELL);
    this.blocked = new Uint8Array(this.cols * this.rows);
    const r = AGENT_RADIUS;
    this.obstacles = layout.shelves.map((s) => ({
      minX: s.transform.x - s.transform.w / 2 - r,
      maxX: s.transform.x + s.transform.w / 2 + r,
      minZ: s.transform.z - s.transform.d / 2 - r,
      maxZ: s.transform.z + s.transform.d / 2 + r,
    }));
    const c = layout.store.counter;
    this.obstacles.push({ minX: c.x - c.w / 2 - r, maxX: c.x + c.w / 2 + r, minZ: c.z - c.d / 2 - r, maxZ: c.z + c.d / 2 + r });
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const { x, z } = this.cellCenter(col, row);
        const nearWall =
          x < this.minX + WALL_MARGIN || x > -this.minX - WALL_MARGIN || z < this.minZ + WALL_MARGIN || z > -this.minZ - WALL_MARGIN;
        const inObstacle = this.obstacles.some((o) => x >= o.minX && x <= o.maxX && z >= o.minZ && z <= o.maxZ);
        if (nearWall || inObstacle) this.blocked[row * this.cols + col] = 1;
      }
    }
  }

  cellCenter(col: number, row: number): Point2 {
    return { x: this.minX + (col + 0.5) * CELL, z: this.minZ + (row + 0.5) * CELL };
  }

  cellOf(p: Point2): [number, number] {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor((p.x - this.minX) / CELL)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((p.z - this.minZ) / CELL)));
    return [col, row];
  }

  isFree(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows && this.blocked[row * this.cols + col] === 0;
  }

  isPointFree(p: Point2): boolean {
    const [c, r] = this.cellOf(p);
    return this.isFree(c, r);
  }

  /** Nearest walkable cell (breadth-first ring search). */
  nearestFree(p: Point2): [number, number] | null {
    const [c0, r0] = this.cellOf(p);
    if (this.isFree(c0, r0)) return [c0, r0];
    for (let rad = 1; rad < Math.max(this.cols, this.rows); rad++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          if (!this.isFree(c0 + dc, r0 + dr)) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) {
            bestD = d;
            best = [c0 + dc, r0 + dr];
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Exact grid line-of-sight: visits every cell the segment touches (Amanatides–Woo). */
  lineOfSight(a: Point2, b: Point2): boolean {
    let [c, r] = this.cellOf(a);
    const [ec, er] = this.cellOf(b);
    if (!this.isFree(c, r)) return false;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const stepC = dx > 0 ? 1 : -1;
    const stepR = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
    const nextX = this.minX + (c + (dx > 0 ? 1 : 0)) * CELL;
    const nextZ = this.minZ + (r + (dz > 0 ? 1 : 0)) * CELL;
    let tMaxX = dx !== 0 ? (nextX - a.x) / dx : Infinity;
    let tMaxZ = dz !== 0 ? (nextZ - a.z) / dz : Infinity;
    let guard = this.cols + this.rows + 4;
    while ((c !== ec || r !== er) && guard-- > 0) {
      if (Math.abs(tMaxX - tMaxZ) < 1e-9) {
        // passing exactly through a corner: both neighbours must be free
        if (!this.isFree(c + stepC, r) || !this.isFree(c, r + stepR)) return false;
        c += stepC;
        r += stepR;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      } else if (tMaxX < tMaxZ) {
        c += stepC;
        tMaxX += tDeltaX;
      } else {
        r += stepR;
        tMaxZ += tDeltaZ;
      }
      if (!this.isFree(c, r)) return false;
    }
    return true;
  }

  /** A* with 8-neighbours, no diagonal corner cutting, then string-pulling. */
  findPath(from: Point2, to: Point2): Point2[] | null {
    const start = this.nearestFree(from);
    const goal = this.nearestFree(to);
    if (!start || !goal) return null;
    const N = this.cols * this.rows;
    const idx = (c: number, r: number) => r * this.cols + c;
    const g = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open = new MinHeap();
    const [gc, gr] = goal;
    const h = (c: number, r: number) => {
      const dx = Math.abs(c - gc);
      const dz = Math.abs(r - gr);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    const s = idx(start[0], start[1]);
    g[s] = 0;
    open.push(s, h(start[0], start[1]));
    const goalIdx = idx(gc, gr);
    while (open.size) {
      const cur = open.pop();
      if (cur === goalIdx) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % this.cols;
      const cr = (cur - cc) / this.cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nc = cc + dc;
          const nr = cr + dr;
          if (!this.isFree(nc, nr)) continue;
          if (dc && dr && (!this.isFree(cc + dc, cr) || !this.isFree(cc, cr + dr))) continue; // no corner cut
          const ni = idx(nc, nr);
          if (closed[ni]) continue;
          const ng = g[cur] + (dc && dr ? Math.SQRT2 : 1);
          if (ng < g[ni]) {
            g[ni] = ng;
            came[ni] = cur;
            open.push(ni, ng + h(nc, nr));
          }
        }
      }
    }
    if (g[goalIdx] === Infinity) return null;
    const cells: Point2[] = [];
    for (let i = goalIdx; i !== -1; i = came[i]) {
      const c = i % this.cols;
      cells.push(this.cellCenter(c, (i - c) / this.cols));
    }
    cells.reverse();
    // exact endpoints when they are walkable
    if (this.isPointFree(to)) cells[cells.length - 1] = { ...to };
    return this.smooth([{ ...from }, ...cells.slice(1)]);
  }

  private smooth(points: Point2[]): Point2[] {
    if (points.length <= 2) return points;
    const out: Point2[] = [points[0]];
    let anchor = 0;
    for (let i = 2; i < points.length; i++) {
      if (!this.lineOfSight(points[anchor], points[i])) {
        out.push(points[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(points[points.length - 1]);
    return out;
  }

  randomFreePoint(rand: () => number): Point2 {
    for (let i = 0; i < 200; i++) {
      const c = Math.floor(rand() * this.cols);
      const r = Math.floor(rand() * this.rows);
      if (this.isFree(c, r)) return this.cellCenter(c, r);
    }
    return { x: 0, z: 0 };
  }
}

class MinHeap {
  private items: number[] = [];
  private prios: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, prio: number): void {
    this.items.push(item);
    this.prios.push(prio);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prios[p] <= this.prios[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0];
    const lastI = this.items.pop()!;
    const lastP = this.prios.pop()!;
    if (this.items.length) {
      this.items[0] = lastI;
      this.prios[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prios[l] < this.prios[m]) m = l;
        if (r < this.items.length && this.prios[r] < this.prios[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prios[a], this.prios[b]] = [this.prios[b], this.prios[a]];
  }
}

export function pathLength(path: Point2[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return d;
}
