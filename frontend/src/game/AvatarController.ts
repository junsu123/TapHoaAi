// Per-avatar runtime logic (pure TypeScript, no three.js) — executes WALK_PICKUP_SHOW:
// walk → inspect → pickup → hold → show → return → leave, with timeouts and a guaranteed
// release of the held box on every exit path (SPEC C1, H3).

import type { AvatarInfo, CharacterAction, ClientGameMessage, Point2, ShelfLayout } from "../types/protocol";
import { AnimationFSM, type AnimState } from "./AnimationFSM";
import type { NavGrid } from "./Navigation";

export const WALK_SPEED = 1.5; // m/s
const ARRIVE_EPS = 0.06;
const PICKUP_SECONDS = 0.6;
const RETURN_SECONDS = 0.6;
const HOLD_SECONDS = 0.4;
const INSPECT_SECONDS = 0.8;
const PREEMPT_SHOW_SECONDS = 0.8;
const STUCK_CHECK_SECONDS = 3;
const STUCK_FAIL_SECONDS = 10;
const PROGRESS_EVERY = 4;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface WorldQuery {
  nav: NavGrid;
  shelf(code: string): ShelfLayout | undefined;
  slotWorld(shelfCode: string, slotCode: string): Vec3 | null;
  neighbours(selfId: string): Point2[];
  rand(): number;
  door: Point2;
}

export type Phase =
  | "none"
  | "wander"
  | "to_stand"
  | "inspect"
  | "pickup"
  | "hold"
  | "show"
  | "return"
  | "leave"
  | "to_wait"
  | "waiting"
  | "exiting";

export interface HeldItem {
  productId: string;
  commandId: string;
  mode: "toHand" | "inHand" | "toShelf";
  t: number; // 0..1 interpolation between slot and hand
  slot: Vec3;
}

export class AvatarController {
  info: AvatarInfo;
  pos: Point2;
  yaw = Math.PI; // facing the shelves (−z) initially
  targetYaw = Math.PI;
  fsm = new AnimationFSM();
  phase: Phase = "none";
  cmd: CharacterAction | null = null;
  held: HeldItem | null = null;
  preempt = false;
  removed = false;
  waitingFor: string | null = null;
  lastFailure: string | null = null;
  completed: string[] = [];

  private path: Point2[] = [];
  private pathIdx = 0;
  private showLeft = 0;
  private wanderIn = 0;
  private stuckCheckT = 0;
  private stuckFor = 0;
  private lastCheckPos: Point2;
  private progressT = 0;
  private walkGoal: Point2 | null = null;
  private seen = new Set<string>();

  constructor(info: AvatarInfo, spawn: Point2, private world: WorldQuery, private emit: (m: ClientGameMessage) => void) {
    this.info = info;
    this.pos = { ...spawn };
    this.lastCheckPos = { ...spawn };
    this.wanderIn = 1.5 + world.rand() * 2;
    this.fsm.force("wave");
  }

  get state(): AnimState {
    return this.fsm.state;
  }

  get busy(): boolean {
    return this.cmd !== null;
  }

  // ------------------------------------------------------------------ commands
  receiveAction(a: CharacterAction): void {
    this.emit({ type: "ACK", command_id: a.command_id }); // idempotent
    if (this.seen.has(a.command_id)) return; // duplicate delivery or replay
    this.seen.add(a.command_id);
    if (this.cmd) this.abort(null); // should not happen: backend runs one at a time
    const shelf = this.world.shelf(a.shelf_id);
    const stand = shelf?.stand_positions[a.stand_index] ?? shelf?.stand_positions[0];
    if (!shelf || !stand) return this.failWith(a.command_id, "unknown_shelf");
    this.cmd = a;
    this.preempt = false;
    this.waitingFor = null;
    if (!this.walkTo(stand)) return this.fail("no_path");
    this.phase = "to_stand";
    this.emit({ type: "ACTION_STARTED", command_id: a.command_id });
    this.progress("walk");
  }

  waitNear(shelfCode: string, waitIndex: number, commandId: string): void {
    if (this.cmd) return;
    const shelf = this.world.shelf(shelfCode);
    const spot = shelf?.wait_positions[waitIndex % Math.max(1, shelf.wait_positions.length)];
    if (!spot) return;
    this.waitingFor = commandId;
    if (this.walkTo(spot)) this.phase = "to_wait";
  }

  requestPreempt(commandId: string): void {
    if (this.cmd?.command_id === commandId) this.preempt = true;
  }

  reset(_reason: string): void {
    this.held = null;
    this.cmd = null;
    this.preempt = false;
    this.phase = "none";
    this.path = [];
    this.fsm.force("idle");
    this.wanderIn = 2;
  }

  effect(kind: string): void {
    if (this.cmd || this.phase === "exiting") return;
    const map: Record<string, AnimState> = { wave: "wave", dance: "dance", gift: "celebrate", follow: "wave", like: "celebrate" };
    const st = map[kind];
    if (!st) return;
    this.phase = "none";
    this.path = [];
    this.fsm.force(st);
    this.targetYaw = 0; // face the camera
  }

  exit(): void {
    if (this.cmd) this.abort("exit");
    this.held = null;
    if (this.walkTo(this.world.door)) {
      this.phase = "exiting";
      this.fsm.force("walk");
    } else {
      this.removed = true;
    }
  }

  // ------------------------------------------------------------------ helpers
  private progress(phase: string): void {
    this.progressT = 0;
    if (this.cmd) this.emit({ type: "ACTION_PROGRESS", command_id: this.cmd.command_id, phase });
  }

  private walkTo(goal: Point2): boolean {
    const path = this.world.nav.findPath(this.pos, goal);
    if (!path) return false;
    this.path = path;
    this.pathIdx = 1;
    this.walkGoal = { ...goal };
    this.stuckFor = 0;
    this.stuckCheckT = 0;
    this.lastCheckPos = { ...this.pos };
    this.fsm.force("walk");
    return true;
  }

  private releaseItem(): void {
    this.held = null; // clone is disposed by the renderer when `held` disappears
  }

  private failWith(commandId: string, reason: string): void {
    this.lastFailure = reason;
    this.emit({ type: "ACTION_FAILED", command_id: commandId, reason });
  }

  private fail(reason: string): void {
    const id = this.cmd?.command_id;
    this.releaseItem();
    this.cmd = null;
    this.preempt = false;
    this.phase = "none";
    this.path = [];
    this.fsm.force("idle");
    if (id) this.failWith(id, reason);
  }

  private abort(reason: string | null): void {
    if (reason) this.fail(reason);
    else {
      this.releaseItem();
      this.cmd = null;
    }
  }

  private complete(): void {
    const c = this.cmd!;
    this.emit({ type: "ACTION_COMPLETED", command_id: c.command_id, reason: this.preempt ? "preempted" : undefined });
    this.completed.push(c.command_id);
    if (this.completed.length > 20) this.completed.shift();
    this.cmd = null;
    this.preempt = false;
  }

  /** Moves along the path; returns true on arrival. */
  private move(dt: number): boolean {
    if (this.pathIdx >= this.path.length) return true;
    const target = this.path[this.pathIdx];
    let dx = target.x - this.pos.x;
    let dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ARRIVE_EPS) {
      this.pathIdx += 1;
      return this.pathIdx >= this.path.length;
    }
    const step = Math.min(dist, WALK_SPEED * dt);
    dx /= dist;
    dz /= dist;
    let nx = this.pos.x + dx * step;
    let nz = this.pos.z + dz * step;
    // light separation from other avatars while walking (not at the final approach)
    const remaining = dist + (this.path.length - 1 - this.pathIdx) * 0.5;
    if (remaining > 0.8) {
      let px = 0;
      let pz = 0;
      for (const o of this.world.neighbours(this.info.avatar_id)) {
        const ox = nx - o.x;
        const oz = nz - o.z;
        const d = Math.hypot(ox, oz);
        if (d > 1e-3 && d < 0.65) {
          px += (ox / d) * (0.65 - d);
          pz += (oz / d) * (0.65 - d);
        }
      }
      const cand = { x: nx + px * 0.5 * dt * 4, z: nz + pz * 0.5 * dt * 4 };
      if (this.world.nav.isPointFree(cand)) {
        nx = cand.x;
        nz = cand.z;
      }
    }
    this.pos = { x: nx, z: nz };
    this.targetYaw = Math.atan2(dx, dz);
    return false;
  }

  private checkStuck(dt: number): boolean {
    this.stuckCheckT += dt;
    if (this.stuckCheckT < STUCK_CHECK_SECONDS) return false;
    const moved = Math.hypot(this.pos.x - this.lastCheckPos.x, this.pos.z - this.lastCheckPos.z);
    this.stuckCheckT = 0;
    this.lastCheckPos = { ...this.pos };
    if (moved >= 0.1) {
      this.stuckFor = 0;
      return false;
    }
    this.stuckFor += STUCK_CHECK_SECONDS;
    if (this.stuckFor >= STUCK_FAIL_SECONDS) return true;
    if (this.walkGoal) {
      const keep = this.stuckFor;
      this.walkTo(this.walkGoal); // re-path
      this.stuckFor = keep;
    }
    return false;
  }

  private faceShelf(): void {
    this.targetYaw = Math.PI; // shelves face +z, so the avatar looks towards −z
  }

  // ------------------------------------------------------------------ frame update
  update(dt: number): void {
    const expired = this.fsm.tick(dt);
    if (this.cmd) {
      this.progressT += dt;
      if (this.progressT >= PROGRESS_EVERY) this.progress(this.phase);
    }
    switch (this.phase) {
      case "to_stand": {
        if (expired) return this.fail("walk_timeout");
        if (this.checkStuck(dt)) return this.fail("path_stuck");
        if (this.move(dt)) {
          this.faceShelf();
          this.phase = "inspect";
          this.fsm.force("inspect");
          this.progress("inspect");
        }
        break;
      }
      case "inspect":
        if (this.fsm.elapsed >= INSPECT_SECONDS) {
          const c = this.cmd!;
          const slot = this.world.slotWorld(c.shelf_id, c.slot_id);
          if (!slot) return this.fail("unknown_slot");
          this.held = { productId: c.product_id, commandId: c.command_id, mode: "toHand", t: 0, slot };
          this.phase = "pickup";
          this.fsm.force("pickup");
          this.progress("pickup");
        }
        break;
      case "pickup":
        if (this.held) this.held.t = Math.min(1, this.held.t + dt / PICKUP_SECONDS);
        if (this.held && this.held.t >= 1) {
          this.held.mode = "inHand";
          this.phase = "hold";
          this.fsm.force("hold");
        } else if (expired) return this.fail("pickup_timeout");
        break;
      case "hold":
        if (this.fsm.elapsed >= HOLD_SECONDS) {
          this.phase = "show";
          this.fsm.force("show");
          this.targetYaw = 0; // turn to the camera
          this.showLeft = this.cmd?.parameters.show_seconds ?? 8;
          this.progress("show");
        }
        break;
      case "show":
        if (this.preempt) this.showLeft = Math.min(this.showLeft, PREEMPT_SHOW_SECONDS);
        this.showLeft -= dt;
        if (this.showLeft <= 0 || expired) {
          this.faceShelf();
          if (this.held) {
            this.held.mode = "toShelf";
            this.held.t = 1;
          }
          this.phase = "return";
          this.fsm.force("return");
          this.progress("return");
        }
        break;
      case "return":
        if (this.held) this.held.t = Math.max(0, this.held.t - dt / RETURN_SECONDS);
        if (!this.held || this.held.t <= 0 || expired) {
          this.releaseItem();
          this.complete();
          const back = { x: this.pos.x + (this.world.rand() - 0.5) * 1.2, z: this.pos.z + 1.3 };
          if (this.walkTo(back)) this.phase = "leave";
          else {
            this.phase = "none";
            this.fsm.force("idle");
          }
        }
        break;
      case "leave":
      case "wander":
        if (this.move(dt) || expired || this.checkStuck(dt)) {
          this.phase = "none";
          this.fsm.force("idle");
          this.wanderIn = 3 + this.world.rand() * 5;
        }
        break;
      case "to_wait":
        if (this.move(dt) || expired) {
          this.faceShelf();
          this.phase = "waiting";
          this.fsm.force("wait");
        }
        break;
      case "waiting":
        if (expired) {
          this.phase = "none";
          this.fsm.force("idle");
        }
        break;
      case "exiting":
        if (this.move(dt) || expired) this.removed = true;
        break;
      case "none": {
        const st = this.fsm.state;
        if (st !== "idle" && expired) this.fsm.force("idle");
        if (this.fsm.state === "idle") {
          this.wanderIn -= dt;
          if (this.wanderIn <= 0) {
            const goal = this.world.nav.randomFreePoint(this.world.rand);
            if (this.walkTo(goal)) this.phase = "wander";
            this.wanderIn = 4 + this.world.rand() * 4;
          }
        }
        break;
      }
    }
    // smooth turning
    let d = this.targetYaw - this.yaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.yaw += d * Math.min(1, dt * 8);
  }
}
