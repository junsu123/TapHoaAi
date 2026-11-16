// Per-avatar runtime logic (pure TypeScript, no three.js) — executes WALK_PICKUP_SHOW:
// walk → inspect → pickup → hold → show → return → leave, with timeouts and a guaranteed
// release of the held box on every exit path (SPEC C1, H3).

import type { AvatarInfo, CharacterAction, ClientGameMessage, Point2, ShelfLayout } from "../types/protocol";
import { AnimationFSM, type AnimState } from "./AnimationFSM";
import { mulberry, pickBehavior, type AutoPlan, type BehaviorConfig, type Partner, type Seat, type TopState } from "./behaviors";
import type { ClipLibrary } from "./clips";
import type { NavGrid } from "./Navigation";
import type { TeaSpot } from "./teahouse";
import { STAGE_MOVE_SECONDS, STAGE_MOVES, type StageSpot } from "./stage";

export const WALK_SPEED = 1.5; // m/s
const ARRIVE_EPS = 0.06;
const PICKUP_SECONDS = 0.6;
const RETURN_SECONDS = 0.6;
const HOLD_SECONDS = 0.4;
const INSPECT_SECONDS = 0.8;
const PREEMPT_SHOW_SECONDS = 0.8;
const STUCK_CHECK_SECONDS = 3;
const STUCK_FAIL_SECONDS = 9; // re-path at 3 s and 6 s, give up at 9 s (spec: retry 2×)
const PROGRESS_EVERY = 4;
const DUPLICATE_WINDOW = 4; // the same direct command again within this window is ignored
const DIRECT_TTL = 30; // queued direct commands older than this are dropped
const MAX_DIRECT_PENDING = 2;
const SOCIAL_AGAIN = 40; // a Chibi is greeted / greets at most once per this many seconds
const CHEER_AGAIN = 60; // claps for someone else's product at most once per minute
const STAND_UP_SECONDS = 0.45;

/** Direct commands from comments / events that play a full-body animation (spec §3.6, §8). */
const DIRECT: Record<string, { id: string; anim: AnimState; seconds: number; state: TopState; emote?: string }> = {
  wave: { id: "SOCIAL_WAVE", anim: "wave", seconds: 1.4, state: "SOCIALIZING" },
  dance: { id: "FUN_DANCE", anim: "dance", seconds: 3, state: "PLAYING", emote: "♪" },
  gift: { id: "FUN_CHEER", anim: "celebrate", seconds: 1.6, state: "PLAYING", emote: "★" },
  follow: { id: "FUN_CHEER", anim: "celebrate", seconds: 1.6, state: "PLAYING", emote: "★" },
  pose: { id: "FUN_POSE", anim: "pose", seconds: 1.8, state: "PLAYING", emote: "★" },
  surprise: { id: "PRODUCT_NOT_FOUND", anim: "surprise", seconds: 1.5, state: "IDLE", emote: "!" },
  think: { id: "PRODUCT_AMBIGUOUS", anim: "think", seconds: 2.4, state: "IDLE", emote: "?" },
  nod: { id: "SOCIAL_NOD", anim: "nod", seconds: 1.2, state: "SOCIALIZING" },
  cheer: { id: "FUN_CHEER", anim: "cheer", seconds: 2, state: "PLAYING", emote: "★" },
};

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
  // ---- autonomous life (optional so older callers/tests keep working)
  behavior?(): BehaviorConfig;
  shelves?(): ShelfLayout[];
  seats?(): Seat[];
  seatFree?(seatId: string): boolean;
  claimSeat?(seatId: string, avatarId: string): boolean;
  releaseSeat?(seatId: string, avatarId: string): void;
  readSpots?(): { pos: Point2; yaw: number }[];
  partners?(selfId: string, pos: Point2): Partner[];
  socialReply?(partnerId: string, from: AvatarController): boolean;
  cameraBusy?(): boolean;
  spotFree?(p: Point2, selfId: string): boolean;
  /** the host / AI voice is talking: tone down fun (spec §5, T15) */
  hostSpeaking?(): boolean;
  /** animation clips this rig has (missing ones fall back, spec §7 / T12) */
  clips?(): ClipLibrary;
  /** a product command finished: neighbours may clap (FUN_CHEER) */
  onCompleted?(who: AvatarController): void;
}

interface AutoRun {
  plan: AutoPlan;
  stage: "go" | "step" | "do" | "up";
  t: number;
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
  | "goodbye"
  | "exiting"
  | "to_tea"
  | "tea_step"
  | "tea_sit"
  | "tea_up"
  | "auto" // an autonomous activity (spec §3.2)
  | "direct" // a direct command animation: wave, dance, … (spec §3.6)
  | "recover" // walking to a safe spot after a failure (spec §6.4)
  | "to_stage" // walking to the dance stage (their turn)
  | "stage_up"
  | "stage_dance"
  | "stage_down";

export interface HeldItem {
  productId: string;
  commandId: string;
  mode: "toHand" | "inHand" | "toShelf";
  t: number; // 0..1 interpolation between slot and hand
  slot: Vec3;
}

export class AvatarController {
  info: AvatarInfo;
  /** watch-time level (0 … 3) and progress towards the next one (null: not counting / at the top) */
  level = 0;
  /** mini-game wins this LIVE */
  medals = 0;
  levelProgress: number | null = null;
  levelUpAt = -1e9;
  /** seconds since the level-up (for the little "pop" of the new gear) */
  get sinceLevelUp(): number {
    return this.clockT - this.levelUpAt;
  }
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
  private waitShelf: string | null = null;
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
  private teaSeat: Point2 | null = null;
  private teaYaw = 0;
  private teaApproach: Point2 | null = null;
  // ---- behaviour system
  private rng: () => number;
  private clockT = 0;
  auto: AutoRun | null = null;
  recent: string[] = [];
  private lastDone = new Map<string, number>();
  direct: { kind: string; at: number }[] = [];
  private lastDirect = new Map<string, number>();
  private directDef: (typeof DIRECT)[string] | null = null;
  private directId: string | null = null;
  socialAt = -1e9;
  cheerAt = -1e9;
  emote: { icon: string; until: number } | null = null;
  private entering = true;
  private recoverT = 0;
  /** on the dance stage: where, which turn (token), until when (safety) */
  stage: { spot: StageSpot; token: string; seconds: number; danceT: number; bowT: number } | null = null;
  /** behaviour ids, most recent last (debug overlay, tests) */
  history: string[] = [];

  constructor(info: AvatarInfo, spawn: Point2, private world: WorldQuery, private emit: (m: ClientGameMessage) => void) {
    this.level = info.level ?? 0;
    this.medals = info.medals ?? 0;
    this.info = info;
    this.pos = { ...spawn };
    this.lastCheckPos = { ...spawn };
    this.rng = mulberry((info.appearance_seed ?? 1) ^ 0x9e3779b9);
    this.wanderIn = 1.5 + this.rng() * 1.5;
    this.fsm.force("wave"); // ARRIVE_ENTER: wave once at the door, then walk in
    this.note("ARRIVE_ENTER");
  }

  get now(): number {
    return this.clockT;
  }

  private note(id: string): void {
    this.history.push(id);
    if (this.history.length > 40) this.history.shift();
  }

  /** The one top-level state of this Chibi (spec §4). */
  get topState(): TopState {
    if (this.removed) return "DESPAWNED";
    switch (this.phase) {
      case "to_stand":
      case "leave":
      case "wander":
        return "NAVIGATING";
      case "inspect":
      case "pickup":
        return "PICKING";
      case "hold":
        return "HOLDING";
      case "show":
        return "PRESENTING";
      case "return":
        return "RETURNING_ITEM";
      case "to_wait":
      case "waiting":
        return "WAITING_SLOT";
      case "goodbye":
      case "exiting":
        return "LEAVING";
      case "to_tea":
      case "tea_step":
      case "tea_sit":
      case "tea_up":
        return "RESTING";
      case "auto":
        if (this.entering) return "ENTERING";
        return this.auto && this.auto.stage === "go" && this.auto.plan.state !== "NAVIGATING" && this.auto.plan.group !== "rest" ? "NAVIGATING" : (this.auto?.plan.state ?? "IDLE");
      case "direct":
        return this.directDef?.state ?? "IDLE";
      case "recover":
        return "ERROR_RECOVERY";
      case "to_stage":
        return "NAVIGATING";
      case "stage_up":
      case "stage_dance":
      case "stage_down":
        return "PLAYING";
      default:
        return this.entering ? "ENTERING" : "IDLE";
    }
  }

  /** The behaviour id (spec §3) being played right now. */
  get behaviorId(): string {
    switch (this.phase) {
      case "to_stand":
        return "PRODUCT_ROUTE";
      case "inspect":
        return "PRODUCT_APPROACH";
      case "pickup":
        return "PRODUCT_PICK";
      case "hold":
        return "PRODUCT_INSPECT";
      case "show":
        return "PRODUCT_PRESENT";
      case "return":
        return "PRODUCT_RETURN";
      case "leave":
        return "RETURN_TO_IDLE";
      case "to_wait":
      case "waiting":
        return "PRODUCT_WAIT_SLOT";
      case "goodbye":
      case "exiting":
        return "LEAVE_WAVE";
      case "to_tea":
      case "tea_step":
      case "tea_sit":
      case "tea_up":
        return "TEA_GUEST";
      case "auto":
        return this.auto?.plan.id ?? "IDLE_BREATHE";
      case "direct":
        return this.directId ?? "IDLE_BREATHE";
      case "recover":
        return "ERROR_RECOVERY";
      case "to_stage":
      case "stage_up":
      case "stage_dance":
      case "stage_down":
        return "STAGE_DANCE";
      default:
        return this.entering ? "ARRIVE_ENTER" : "IDLE_BREATHE";
    }
  }

  get state(): AnimState {
    return this.fsm.state;
  }

  /** The pose actually drawn: the state's own clip, or the nearest one this rig has (T12). */
  get pose(): AnimState {
    return this.world.clips?.().resolve(this.fsm.state) ?? this.fsm.state;
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
    this.stopActivity(); // a product command outranks any activity (spec §4: priority 2)
    const shelf = this.world.shelf(a.shelf_id);
    const stand = shelf?.stand_positions[a.stand_index] ?? shelf?.stand_positions[0];
    if (!shelf || !stand) return this.failWith(a.command_id, "unknown_shelf");
    this.cmd = a;
    this.preempt = false;
    this.waitingFor = null;
    if (!this.walkTo(stand)) return this.fail("no_path");
    this.phase = "to_stand";
    this.emit({ type: "ACTION_STARTED", command_id: a.command_id });
    this.progress("PATH_FOUND");
    this.note("PRODUCT_ROUTE");
  }

  waitNear(shelfCode: string, waitIndex: number, commandId: string): void {
    if (this.cmd) return;
    this.stopActivity();
    const shelf = this.world.shelf(shelfCode);
    const spot = shelf?.wait_positions[waitIndex % Math.max(1, shelf.wait_positions.length)];
    if (!spot) return;
    this.waitingFor = commandId;
    this.waitShelf = shelfCode;
    if (this.walkTo(spot)) this.phase = "to_wait";
  }

  requestPreempt(commandId: string): void {
    if (this.cmd?.command_id === commandId) this.preempt = true;
  }

  reset(_reason: string): void {
    this.stopActivity();
    this.held = null;
    this.cmd = null;
    this.preempt = false;
    this.phase = "none";
    this.path = [];
    this.fsm.force("idle");
    this.wanderIn = 2;
  }

  // ------------------------------------------------------------------ dance stage
  get onStage(): boolean {
    return this.phase === "to_stage" || this.phase === "stage_up" || this.phase === "stage_dance" || this.phase === "stage_down";
  }

  /** How high the Chibi stands (on the stage platform, half-way on the steps). */
  get elevation(): number {
    const st = this.stage;
    if (!st || (this.phase !== "stage_up" && this.phase !== "stage_dance" && this.phase !== "stage_down")) return 0;
    if (this.phase === "stage_dance") return st.spot.height;
    // on the steps: height grows with the distance walked from the foot of the steps
    const a = st.spot.approach;
    const along = Math.hypot(this.pos.x - a.x, this.pos.z - a.z);
    return st.spot.height * Math.min(1, along / Math.max(0.01, Math.hypot(st.spot.steps.x - a.x, st.spot.steps.z - a.z)));
  }

  /** Their turn on the stage: walk over, climb up, dance until STAGE_END. */
  goOnStage(spot: StageSpot, token: string, seconds: number): boolean {
    if (this.removed || this.phase === "goodbye" || this.phase === "exiting") return false;
    if (this.stage?.token === token) return true; // already going (a resent message)
    if (this.cmd) return false; // the server waits for products to finish; just in case
    if (this.atTea) this.phase = "none";
    this.stopActivity();
    this.direct = [];
    this.stage = { spot, token, seconds, danceT: 0, bowT: 0 };
    if (!this.walkTo(spot.approach)) {
      this.stage = null;
      this.emit({ type: "STAGE_PROGRESS", token, phase: "failed" });
      return false;
    }
    this.phase = "to_stage";
    this.note("STAGE_DANCE");
    return true;
  }

  /** The music stops: bow, step down, back to the shop. */
  leaveStage(token: string): void {
    if (!this.stage || this.stage.token !== token) return;
    if (this.phase === "to_stage") {
      this.stage = null;
      this.phase = "none";
      this.fsm.force("idle");
      this.wanderIn = 1;
      return;
    }
    this.phase = "stage_down";
    this.stage.bowT = 0;
    this.targetYaw = 0;
    this.fsm.force("nod"); // a little bow to the audience first
  }

  // ------------------------------------------------------------------ tea table (gift givers)
  /** Walk to the guest cushion at the tea table and sit opposite the shop owner. */
  visitTea(spot: TeaSpot): boolean {
    if (this.cmd || this.phase === "goodbye" || this.phase === "exiting" || this.phase === "to_wait" || this.phase === "waiting") return false;
    this.stopActivity();
    this.teaSeat = { ...spot.guest };
    this.teaYaw = spot.guestYaw;
    this.teaApproach = { ...spot.guestApproach };
    if (!this.walkTo(spot.guestApproach)) return false;
    this.phase = "to_tea";
    return true;
  }

  /** Stand up from the tea table and go back to browsing. */
  leaveTea(): void {
    if (this.phase !== "tea_sit" && this.phase !== "tea_step" && this.phase !== "to_tea") return;
    const seated = this.phase === "tea_sit";
    this.phase = "tea_up";
    this.fsm.force(seated ? "standup" : "walk");
  }

  get interruptible(): boolean {
    return !this.cmd && (this.phase === "none" || this.phase === "wander" || this.phase === "auto" || this.phase === "direct" || this.phase === "leave");
  }

  get atTea(): boolean {
    return this.phase === "to_tea" || this.phase === "tea_step" || this.phase === "tea_sit" || this.phase === "tea_up";
  }

  /** Straight-line step (the last metre to/from the cushion is inside the table's footprint). */
  private moveDirect(target: Point2, dt: number): boolean {
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < ARRIVE_EPS) {
      this.pos = { ...target };
      return true;
    }
    const step = Math.min(d, WALK_SPEED * 0.7 * dt);
    this.pos = { x: this.pos.x + (dx / d) * step, z: this.pos.z + (dz / d) * step };
    this.targetYaw = Math.atan2(dx, dz);
    return false;
  }

  /**
   * A direct command or event reaction (spec §3.6, §4 priority 3). Emotes (like, share) never
   * interrupt the body; full-body ones run now when the Chibi is free, otherwise they wait in a
   * small queue (2 pending, 30 s TTL). The same request again within 4 s is ignored.
   */
  effect(kind: string): void {
    if (this.removed || this.phase === "goodbye" || this.phase === "exiting") return;
    if (kind === "like" || kind === "share") return this.setEmote("❤", 1.6);
    if (kind === "point") {
      // "xem giá / thành phần" about the box in hand: point at it a little longer
      this.setEmote("i", 2.6);
      if (this.phase === "show") this.showLeft += 2;
      return;
    }
    if (!DIRECT[kind] && kind !== "sit" && kind !== "explore") return;
    const now = this.clockT;
    if (now - (this.lastDirect.get(kind) ?? -1e9) < DUPLICATE_WINDOW) return;
    this.lastDirect.set(kind, now);
    if (kind === "follow" || kind === "gift") this.setEmote("★", 2);
    if (this.interruptible && !(this.phase === "auto" && this.auto?.plan.seat && this.auto.stage !== "go")) {
      this.runDirect(kind);
      return;
    }
    if (this.direct.length >= MAX_DIRECT_PENDING) this.direct.shift();
    this.direct.push({ kind, at: now });
  }

  /** Reached a new level (stayed longer on the LIVE): a star and a little cheer. */
  levelUp(level: number): void {
    this.level = level;
    this.levelUpAt = this.clockT;
    this.levelProgress = 0;
    this.effect("cheer");
    this.setEmote("★", 2.5);
  }

  setEmote(icon: string, seconds: number): void {
    this.emote = { icon, until: this.clockT + seconds };
  }

  private runDirect(kind: string): void {
    this.stopActivity();
    if (kind === "sit" || kind === "explore") {
      const plan = this.planFor(kind === "sit" ? "rest" : "explore");
      if (plan) return void this.startPlan(plan);
      return this.runDirect("think");
    }
    const d = DIRECT[kind];
    this.phase = "direct";
    this.directDef = d;
    this.directId = d.id;
    this.path = [];
    this.targetYaw = 0; // face the camera
    this.fsm.force(d.anim);
    if (d.emote) this.setEmote(d.emote, d.seconds + 0.4);
    this.note(d.id);
  }

  /** Another Chibi greets this one: turn and nod back if not busy. */
  socialReply(from: AvatarController): boolean {
    if (this.clockT - this.socialAt < SOCIAL_AGAIN) return false;
    const idleish = this.phase === "none" || (this.phase === "auto" && this.auto?.stage === "do" && (this.auto.plan.group === "idle" || this.auto.plan.group === "browse"));
    if (!idleish || this.cmd) return false;
    this.stopActivity();
    this.socialAt = this.clockT;
    this.phase = "direct";
    this.directDef = DIRECT.nod;
    this.directId = "SOCIAL_NOD";
    this.targetYaw = Math.atan2(from.pos.x - this.pos.x, from.pos.z - this.pos.z);
    this.fsm.force("nod");
    this.note("SOCIAL_NOD");
    return true;
  }

  /** Someone nearby finished presenting a product: clap for them if free (FUN_CHEER). */
  cheerFor(other: AvatarController): boolean {
    if (this.clockT - this.cheerAt < CHEER_AGAIN || this.cmd) return false;
    const idleish = this.phase === "none" || (this.phase === "auto" && this.auto?.stage === "do" && !this.auto.plan.seat);
    if (!idleish) return false;
    this.stopActivity();
    this.cheerAt = this.clockT;
    this.phase = "direct";
    this.directDef = DIRECT.cheer;
    this.directId = "FUN_CHEER";
    this.targetYaw = Math.atan2(other.pos.x - this.pos.x, other.pos.z - this.pos.z);
    this.fsm.force("cheer");
    this.setEmote("★", 1.6);
    this.note("FUN_CHEER");
    return true;
  }

  // ------------------------------------------------------------------ autonomous life
  private planContext() {
    const w = this.world;
    const seats = (w.seats?.() ?? []).filter((s) => w.seatFree?.(s.id) ?? true);
    return {
      pos: this.pos,
      rand: this.rng,
      nav: w.nav,
      shelves: w.shelves?.() ?? [],
      freeSeats: seats,
      readSpots: w.readSpots?.() ?? [],
      partners: w.partners?.(this.info.avatar_id, this.pos) ?? [],
      spotFree: w.spotFree ? (p: Point2) => w.spotFree!(p, this.info.avatar_id) : undefined,
    };
  }

  private planFor(group: "rest" | "explore"): AutoPlan | null {
    const cfg = this.world.behavior?.();
    if (!cfg) return null;
    const weights = { browse: 0, explore: 0, idle: 0, social: 0, rest: 0, fun: 0, [group]: 1 };
    return pickBehavior({ ...cfg, autonomous_enabled: true, weights }, { recent: [], lastDone: new Map(), now: this.clockT, cameraBusy: false }, this.planContext());
  }

  private startPlan(plan: AutoPlan): boolean {
    if (plan.seat) {
      if (this.world.claimSeat && !this.world.claimSeat(plan.seat.id, this.info.avatar_id)) return false;
      if (!this.walkTo(plan.seat.approach)) {
        this.world.releaseSeat?.(plan.seat.id, this.info.avatar_id);
        return false;
      }
      this.auto = { plan, stage: "go", t: 0 };
    } else if (plan.target) {
      if (!this.walkTo(plan.target)) return false;
      this.auto = { plan, stage: "go", t: 0 };
    } else {
      this.auto = { plan, stage: "do", t: 0 };
      this.beginDo();
    }
    if (plan.partner) {
      this.socialAt = this.clockT;
      this.world.socialReply?.(plan.partner, this);
    }
    this.phase = "auto";
    this.note(plan.id);
    return true;
  }

  private beginDo(): void {
    const a = this.auto!;
    a.stage = "do";
    a.t = 0;
    if (a.plan.face !== undefined) this.targetYaw = a.plan.face;
    this.fsm.force(a.plan.anim);
    if (a.plan.emote) this.setEmote(a.plan.emote, a.plan.seconds);
  }

  /** End the current activity (and give back the bench seat) — called on every exit path. */
  private endActivity(done: boolean): void {
    const a = this.auto;
    if (a) {
      if (a.plan.seat) this.world.releaseSeat?.(a.plan.seat.id, this.info.avatar_id);
      if (done) {
        this.recent.push(a.plan.id);
        if (this.recent.length > 6) this.recent.shift();
        this.lastDone.set(a.plan.id, this.clockT);
      }
    }
    this.auto = null;
    this.entering = false;
  }

  /** Interrupt whatever activity / direct animation is running (no-op otherwise). */
  private stopActivity(): void {
    if (this.onStage) {
      this.stage = null;
      this.phase = "none";
    }
    if (this.phase === "auto") {
      this.endActivity(false);
      this.phase = "none";
    } else if (this.phase === "direct") {
      this.directDef = null;
      this.phase = "none";
    }
    this.entering = false;
  }

  /** where this Chibi is heading for its current activity (spot reservation) */
  get heading(): Point2 | null {
    if (this.phase === "auto" && this.auto) return this.auto.plan.target ?? this.auto.plan.seat?.pos ?? null;
    return this.walkGoal && (this.phase === "to_stand" || this.phase === "to_wait" || this.phase === "recover") ? this.walkGoal : null;
  }

  get sittingOnBench(): Seat | null {
    return this.phase === "auto" && this.auto?.plan.seat && this.auto.stage !== "go" ? this.auto.plan.seat : null;
  }

  get prop(): "cup" | null {
    return this.phase === "auto" && this.auto?.stage === "do" && this.auto.plan.prop === "cup" ? "cup" : null;
  }

  private nextActivity(): void {
    // queued direct commands first (spec §4: direct commands outrank autonomous life)
    while (this.direct.length && this.clockT - this.direct[0].at > DIRECT_TTL) this.direct.shift();
    const d = this.direct.shift();
    if (d) return this.runDirect(d.kind);
    if (this.entering) {
      // ARRIVE_ENTER: walk a few steps into the shop and look around
      const door = this.world.door;
      let target = this.world.nav.randomFreePoint(this.rng);
      for (let i = 0; i < 8; i++) {
        const inside = { x: door.x + (this.rng() - 0.5) * 4, z: door.z - 2 - this.rng() * 2.5 };
        if (this.world.nav.isPointFree(inside) && (this.world.spotFree?.(inside, this.info.avatar_id) ?? true)) {
          target = inside;
          break;
        }
      }
      this.startPlan({ id: "ARRIVE_ENTER", group: "explore", state: "ENTERING", target, anim: "look", seconds: 1.2 });
      return;
    }
    const cfg = this.world.behavior?.();
    if (!cfg) {
      // no behaviour config (tests with a bare world): simple wander, as before
      const goal = this.world.nav.randomFreePoint(this.world.rand);
      if (this.walkTo(goal)) this.phase = "wander";
      return;
    }
    const plan = pickBehavior(
      cfg,
      { recent: this.recent, lastDone: this.lastDone, now: this.clockT, cameraBusy: this.world.cameraBusy?.() ?? false, hostSpeaking: this.world.hostSpeaking?.() ?? false },
      this.planContext(),
    );
    if (!plan || !this.startPlan(plan)) {
      this.fsm.force("idle");
      this.wanderIn = 1 + this.rng() * 2;
    }
  }

  private idleDelay(): number {
    const [a, b] = this.world.behavior?.().idle_delay ?? [1, 4];
    return a + (b - a) * this.rng();
  }

  /** Viewer left (idle, viewer count dropped, LIVE ended): wave goodbye, then walk out. */
  exit(): void {
    if (this.phase === "goodbye" || this.phase === "exiting") return;
    this.stopActivity();
    this.direct = [];
    if (this.cmd) this.abort("exit");
    this.held = null;
    this.path = [];
    this.phase = "goodbye";
    this.targetYaw = 0; // face the camera to wave
    this.fsm.force("wave");
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
    this.path = [];
    if (id) this.failWith(id, reason);
    // ERROR_RECOVERY: walk (never teleport) to a safe open spot, then carry on living
    this.phase = "recover";
    this.recoverT = 0;
    this.note("ERROR_RECOVERY");
    const safe = this.world.nav.randomFreePoint(this.rng);
    if (!this.walkTo(safe)) this.fsm.force("think");
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
    this.world.onCompleted?.(this);
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

  /** Look at the shelf being used (works for any shelf rotation). */
  private faceShelf(): void {
    const code = this.cmd?.shelf_id ?? this.waitShelf;
    const s = code ? this.world.shelf(code) : undefined;
    if (!s) {
      this.targetYaw = Math.PI;
      return;
    }
    // the shelf front faces (sin rot, cos rot); the avatar looks the opposite way
    this.targetYaw = s.transform.rot + Math.PI;
  }

  // ------------------------------------------------------------------ frame update
  update(dt: number): void {
    this.clockT += dt;
    if (this.emote && this.clockT > this.emote.until) this.emote = null;
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
          this.progress("REACHED_SHELF");
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
          this.setEmote("★", 1.0); // FUN_SURPRISE: a little hop of joy, the box is found
          this.progress("PICKED");
        } else if (expired) return this.fail("pickup_timeout");
        break;
      case "hold":
        if (this.fsm.elapsed >= HOLD_SECONDS) {
          this.phase = "show";
          this.fsm.force("show");
          // present the box facing out of the shelf (the close-up camera goes there, so a
          // shelf never sits between the lens and the product); rot=0 → towards the main camera
          this.targetYaw = this.world.shelf(this.cmd!.shelf_id)?.transform.rot ?? 0;
          this.showLeft = this.cmd?.parameters.show_seconds ?? 8;
          this.progress("PRESENTED");
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
          this.progress("RETURNING");
        }
        break;
      case "return":
        if (this.held) this.held.t = Math.max(0, this.held.t - dt / RETURN_SECONDS);
        if (!this.held || this.held.t <= 0 || expired) {
          this.releaseItem();
          this.progress("RETURNED");
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
          this.wanderIn = this.idleDelay();
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
      case "goodbye":
        if (this.fsm.elapsed >= 1.2) {
          if (this.walkTo(this.world.door)) this.phase = "exiting";
          else this.removed = true;
        }
        break;
      case "exiting":
        if (this.move(dt) || expired) this.removed = true;
        break;
      case "to_tea":
        if (expired || this.checkStuck(dt)) {
          this.phase = "none";
          this.fsm.force("idle");
        } else if (this.move(dt)) {
          this.phase = "tea_step";
          this.fsm.force("walk");
        }
        break;
      case "tea_step":
        if (!this.teaSeat || expired) {
          this.phase = "none";
          this.fsm.force("idle");
        } else if (this.moveDirect(this.teaSeat, dt)) {
          this.targetYaw = this.teaYaw;
          this.phase = "tea_sit";
          this.fsm.force("sit");
        }
        break;
      case "tea_sit":
        this.targetYaw = this.teaYaw;
        if (expired) this.leaveTea();
        break;
      case "tea_up":
        if (this.fsm.state === "standup") {
          if (this.fsm.elapsed >= STAND_UP_SECONDS) this.fsm.force("walk");
        } else if (!this.teaApproach || this.moveDirect(this.teaApproach, dt) || expired) {
          this.phase = "none";
          this.targetYaw = 0;
          this.fsm.force("wave");
          this.wanderIn = 2;
        }
        break;
      case "auto": {
        const a = this.auto!;
        if (a.stage === "go") {
          if (expired || this.checkStuck(dt)) {
            this.endActivity(false);
            this.phase = "none";
            this.fsm.force("idle");
            this.wanderIn = this.idleDelay();
          } else if (this.move(dt)) {
            if (a.plan.seat) {
              a.stage = "step";
              this.fsm.force("walk");
            } else this.beginDo();
          }
        } else if (a.stage === "step") {
          if (this.moveDirect(a.plan.seat!.pos, dt) || expired) this.beginDo();
        } else if (a.stage === "do") {
          a.t += dt;
          if (a.plan.face !== undefined) this.targetYaw = a.plan.face;
          const x = a.plan.extra;
          if (x) {
            // a short extra moment inside the activity (FUN_YAWN on the bench)
            const inside = a.t >= x.at && a.t < x.at + x.seconds;
            if (inside && this.fsm.state !== x.anim) {
              this.fsm.force(x.anim);
              this.note(x.id);
            } else if (!inside && this.fsm.state === x.anim) this.fsm.force(a.plan.anim);
          }
          if (a.t >= a.plan.seconds) {
            if (a.plan.seat) {
              a.stage = "up";
              this.fsm.force("standup");
            } else {
              this.endActivity(true);
              this.phase = "none";
              this.fsm.force("idle");
              this.wanderIn = this.idleDelay();
            }
          }
        } else if (a.stage === "up") {
          if (this.fsm.state === "standup") {
            if (this.fsm.elapsed >= STAND_UP_SECONDS) this.fsm.force("walk");
          } else if (this.moveDirect(a.plan.seat!.approach, dt) || expired) {
            this.endActivity(true);
            this.phase = "none";
            this.fsm.force("idle");
            this.wanderIn = this.idleDelay();
          }
        }
        break;
      }
      case "direct":
        if (!this.directDef || this.fsm.elapsed >= this.directDef.seconds || expired) {
          this.directDef = null;
          this.phase = "none";
          this.fsm.force("idle");
          this.wanderIn = this.direct.length ? 0.2 : this.idleDelay();
        }
        break;
      case "to_stage": {
        const st = this.stage;
        if (!st) {
          this.phase = "none";
          break;
        }
        if (expired || this.checkStuck(dt)) {
          this.emit({ type: "STAGE_PROGRESS", token: st.token, phase: "failed" });
          this.stage = null;
          this.phase = "none";
          this.fsm.force("idle");
        } else if (this.move(dt)) {
          this.phase = "stage_up";
          this.fsm.force("walk");
        }
        break;
      }
      case "stage_up": {
        const st = this.stage!;
        if (this.moveDirect(st.spot.top, dt) || expired) {
          this.phase = "stage_dance";
          st.danceT = 0;
          this.targetYaw = 0; // face the audience
          this.fsm.force(STAGE_MOVES[0]);
          this.setEmote("♪", 2);
          this.emit({ type: "STAGE_PROGRESS", token: st.token, phase: "on_stage" });
        }
        break;
      }
      case "stage_dance": {
        const st = this.stage!;
        st.danceT += dt;
        this.targetYaw = 0;
        const move = STAGE_MOVES[Math.floor(st.danceT / STAGE_MOVE_SECONDS) % STAGE_MOVES.length];
        if (this.fsm.state !== move || this.fsm.elapsed > STAGE_MOVE_SECONDS) this.fsm.force(move);
        if (!this.emote) this.setEmote(st.danceT % 4 < 2 ? "♪" : "★", 1.6);
        // the server ends the turn; a lost message must not leave a dancer up there forever
        if (st.danceT > st.seconds + 12) this.leaveStage(st.token);
        break;
      }
      case "stage_down": {
        const st = this.stage!;
        st.bowT += dt;
        if (st.bowT < 1.2) break; // bowing
        if (this.fsm.state !== "walk") this.fsm.force("walk");
        if (this.moveDirect(st.spot.approach, dt) || st.bowT > 6) {
          this.stage = null;
          this.phase = "none";
          this.fsm.force("wave");
          this.wanderIn = 1.5;
        }
        break;
      }
      case "recover":
        this.recoverT += dt;
        if (this.move(dt) || expired || this.recoverT > 12 || (this.path.length === 0 && this.recoverT > 1.5)) {
          this.phase = "none";
          this.fsm.force("idle");
          this.wanderIn = this.idleDelay();
        }
        break;
      case "none": {
        const st = this.fsm.state;
        if (st !== "idle" && expired) this.fsm.force("idle");
        if (this.fsm.state === "idle") {
          this.wanderIn -= dt;
          if (this.wanderIn <= 0 || (this.direct.length && this.wanderIn > 0.2)) {
            this.wanderIn = 4 + this.rng() * 4;
            this.nextActivity();
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
