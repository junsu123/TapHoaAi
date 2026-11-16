// Client-side game state: applies server messages, steps avatar controllers every frame,
// decides the camera framing. Rendering components read from here without re-rendering
// React on every frame.

import type {
  AvatarInfo,
  ClientGameMessage,
  GameSnapshot,
  Point2,
  ProductInfo,
  SceneConfig,
  ServerGameMessage,
  ShelfLayout,
  StoreLayout,
} from "../types/protocol";
import { DEFAULT_SCENE, type LeaderboardView, type StageView } from "../types/protocol";
import { TeaHouse, teaSpot, type TeaSpot } from "./teahouse";
import { stageSpot, type StageSpot } from "./stage";
import { benchSpots, DEFAULT_BEHAVIOR, type Bench, type BehaviorConfig } from "./behaviors";
import { AvatarController, type Vec3, type WorldQuery } from "./AvatarController";
import { ClipLibrary, PROCEDURAL_CLIPS } from "./clips";
import { NavGrid } from "./Navigation";

export interface CameraState {
  mode: "overview" | "follow";
  avatarId: string | null;
  commandId: string | null;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class GameEngine {
  layout: StoreLayout | null = null;
  nav: NavGrid | null = null;
  products = new Map<string, ProductInfo>();
  shelves = new Map<string, ShelfLayout>();
  avatars = new Map<string, AvatarController>();
  camera: CameraState = { mode: "overview", avatarId: null, commandId: null };
  isDemo = false;
  liveStatus = "Chưa kết nối";
  sessionId: string | null = null;
  layoutVersion = 0;
  scene: SceneConfig = DEFAULT_SCENE;
  /** tea corner: shop owner, guest cushion (null when the owner is switched off) */
  spot: TeaSpot | null = null;
  tea = new TeaHouse((id) => this.avatars.get(id));
  board: LeaderboardView | null = null;
  /** the dance stage: where it stands, and who dances / waits (from the server) */
  stageSpot: StageSpot | null = null;
  stage: StageView | null = null;
  /** owner's head on screen (0..1), written by the renderer, read by the speech bubble */
  ownerScreen: { x: number; y: number; visible: boolean } = { x: 0.5, y: 0.4, visible: false };
  /** what the LED wall shows (written by the renderer; tests read it) */
  led: { mode: string; productId: string | null } = { mode: "", productId: null };
  boardVersion = 0;
  /** bumps when the shop look changes (re-builds the 3D scene) */
  sceneVersion = 0;
  /** bumps whenever the set of avatars or the layout changes (React re-render trigger) */
  version = 0;
  sent: ClientGameMessage[] = [];
  private rand = mulberry32(12345);
  private world: WorldQuery;

  constructor(private send: (m: ClientGameMessage) => void) {
    this.world = {
      nav: null as unknown as NavGrid,
      shelf: (code) => this.shelves.get(code),
      slotWorld: (s, sl) => this.slotWorld(s, sl),
      neighbours: (selfId) => {
        const out: Point2[] = [];
        for (const a of this.avatars.values()) if (a.info.avatar_id !== selfId) out.push(a.pos);
        return out;
      },
      rand: () => this.rand(),
      door: { x: 0, z: 7.4 },
      behavior: () => this.behavior,
      shelves: () => [...this.shelves.values()],
      seats: () => this.benches.flatMap((b) => b.seats),
      seatFree: (id) => !this.seatHolders.has(id),
      claimSeat: (id, who) => {
        const h = this.seatHolders.get(id);
        if (h && h !== who) return false;
        this.seatHolders.set(id, who);
        return true;
      },
      releaseSeat: (id, who) => {
        if (this.seatHolders.get(id) === who) this.seatHolders.delete(id);
      },
      readSpots: () => this.readSpots,
      partners: (selfId, pos) => {
        const out: { id: string; pos: Point2 }[] = [];
        for (const a of this.avatars.values()) {
          if (a.info.avatar_id === selfId || a.busy || a.topState !== "IDLE") continue;
          if (a.now - a.socialAt < 40) continue;
          if (Math.hypot(a.pos.x - pos.x, a.pos.z - pos.z) < 3.2) out.push({ id: a.info.avatar_id, pos: a.pos });
        }
        return out;
      },
      socialReply: (partnerId, from) => this.avatars.get(partnerId)?.socialReply(from) ?? false,
      cameraBusy: () => this.camera.mode === "follow" && !!this.camera.commandId,
      hostSpeaking: () => this.hostSpeaking,
      clips: () => this.clips,
      onCompleted: (who) => this.cheerFor(who),
      spotFree: (p, selfId) => {
        for (const a of this.avatars.values()) {
          if (a.info.avatar_id === selfId) continue;
          if (Math.hypot(a.pos.x - p.x, a.pos.z - p.z) < 0.6) return false;
          const h = a.heading;
          if (h && Math.hypot(h.x - p.x, h.z - p.z) < 0.6) return false;
        }
        return true;
      },
    };
  }

  /** screen positions of Chibi heads, filled only when the debug overlay is on */
  debugScreens = new Map<string, { x: number; y: number; on: boolean }>();
  /** autonomous-life settings (spec §5); the server may send its own */
  behavior: BehaviorConfig = DEFAULT_BEHAVIOR;
  /** animation clips the Chibi rig has; missing ones fall back (T12) */
  clips = new ClipLibrary(PROCEDURAL_CLIPS);
  /** the host / AI voice is talking right now (T15) */
  hostSpeaking = false;
  /** render level of detail per Chibi, decided by the renderer each frame (T16) */
  lod = { full: 0, reduced: 0, far: 0, hidden: 0 };
  /** 0 = everyone in full, 1 = crowded, 2 = very crowded / slow PC */
  lodLevel: 0 | 1 | 2 = 0;
  /** benches for REST_* and who sits on which seat */
  benches: Bench[] = [];
  private seatHolders = new Map<string, string>();
  private readSpots: { pos: Point2; yaw: number }[] = [];

  private emit = (m: ClientGameMessage): void => {
    this.sent.push(m);
    if (this.sent.length > 300) this.sent.shift();
    this.send(m);
  };

  setLayout(layout: StoreLayout): void {
    this.layout = layout;
    this.layoutVersion = layout.version;
    this.rebuildNav();
    this.world.door = { x: layout.store.door.x, z: Math.min(layout.store.door.z, layout.store.depth / 2 - 0.6) };
    this.products = new Map(layout.products.map((p) => [p.id, p]));
    this.shelves = new Map(layout.shelves.map((s) => [s.code, s]));
    this.version++;
  }

  /** For a rig without some clips (or a test): those clips fall back to the nearest one. */
  setMissingClips(missing: string[]): void {
    const gone = new Set(missing);
    this.clips = new ClipLibrary(PROCEDURAL_CLIPS.filter((c) => !gone.has(c)));
  }

  setSpeaking(on: boolean): void {
    this.hostSpeaking = on;
  }

  /** A Chibi just finished presenting a product: up to two free neighbours clap (FUN_CHEER). */
  private cheerFor(who: AvatarController): void {
    if (this.behavior.weights.fun <= 0 || !this.behavior.autonomous_enabled || this.hostSpeaking) return;
    const near = [...this.avatars.values()]
      .filter((a) => a !== who && !a.removed && Math.hypot(a.pos.x - who.pos.x, a.pos.z - who.pos.z) < 4)
      .sort((a, b) => Math.hypot(a.pos.x - who.pos.x, a.pos.z - who.pos.z) - Math.hypot(b.pos.x - who.pos.x, b.pos.z - who.pos.z));
    let n = 0;
    for (const a of near) {
      if (n >= 2) break;
      if (a.cheerFor(who)) n++;
    }
  }

  setScene(scene: SceneConfig): void {
    const ownerWas = this.scene.owner_enabled;
    const stageWas = `${this.scene.stage_enabled}|${this.scene.stage_side}`;
    this.scene = { ...DEFAULT_SCENE, ...scene };
    this.behavior = behaviorFromScene(this.scene);
    if (this.layout && (ownerWas !== this.scene.owner_enabled || stageWas !== `${this.scene.stage_enabled}|${this.scene.stage_side}`))
      this.rebuildNav();
    this.sceneVersion++;
    this.version++;
  }

  /** Walkable map: shelves and counter, plus the tea table when the shop owner is on. */
  private rebuildNav(): void {
    if (!this.layout) return;
    this.spot = this.scene.owner_enabled ? teaSpot(this.layout) : null;
    this.benches = benchSpots(this.layout);
    this.stageSpot = this.scene.stage_enabled ? stageSpot(this.layout, this.scene.stage_side) : null;
    this.nav = new NavGrid(this.layout, [
      ...(this.spot ? [this.spot.obstacle] : []),
      ...this.benches.map((b) => b.obstacle),
      ...(this.stageSpot ? [this.stageSpot.obstacle] : []),
    ]);
    this.world.nav = this.nav;
    // READ_SIGN: in front of the counter, looking at the LED screen / sign on the back wall
    const c = this.layout.store.counter;
    this.readSpots = [-2.2, 2.2]
      .map((dx) => ({ pos: { x: c.x + dx, z: c.z + c.d / 2 + 1.0 }, yaw: Math.PI }))
      .filter((r) => this.nav!.isPointFree(r.pos));
  }

  /** Products shown on the banner/posters: the chosen ones, else every product with a photo. */
  bannerProducts(): ProductInfo[] {
    const withPhoto = (p: ProductInfo | undefined): p is ProductInfo => !!p && !!(p.card_image_url || p.image_url);
    const chosen = this.scene.banner_product_ids.map((id) => this.products.get(id)).filter(withPhoto);
    return chosen.length ? chosen : [...this.products.values()].filter(withPhoto);
  }

  slotWorld(shelfCode: string, slotCode: string): Vec3 | null {
    const s = this.shelves.get(shelfCode);
    const slot = s?.slots.find((x) => x.code === slotCode);
    if (!s || !slot) return null;
    const c = Math.cos(s.transform.rot);
    const sn = Math.sin(s.transform.rot);
    return {
      x: s.transform.x + slot.local.x * c + slot.local.z * sn,
      y: slot.local.y,
      z: s.transform.z - slot.local.x * sn + slot.local.z * c,
    };
  }

  private spawnPoint(onReload: boolean): Point2 {
    const door = this.world.door;
    if (onReload && this.nav) return this.nav.randomFreePoint(this.world.rand);
    const p = { x: door.x + (this.rand() - 0.5) * 1.6, z: door.z - this.rand() * 0.6 };
    return this.nav && !this.nav.isPointFree(p) ? door : p;
  }

  private addAvatar(info: AvatarInfo, onReload = false): AvatarController {
    const existing = this.avatars.get(info.avatar_id);
    if (existing && !existing.removed && existing.phase !== "exiting" && existing.phase !== "goodbye") {
      existing.info = info;
      return existing;
    }
    const ctl = new AvatarController(info, this.spawnPoint(onReload), this.world, this.emit);
    this.avatars.set(info.avatar_id, ctl);
    this.version++;
    return ctl;
  }

  applySnapshot(s: GameSnapshot): void {
    this.sessionId = s.session_id;
    this.isDemo = s.is_demo;
    this.liveStatus = s.live_status;
    this.setLayout(s.layout);
    if (s.scene) this.setScene(s.scene);
    if (s.board) {
      this.board = s.board;
      this.boardVersion++;
    }
    const keep = new Set(s.avatars.map((a) => a.avatar_id));
    for (const id of [...this.avatars.keys()]) if (!keep.has(id)) this.avatars.delete(id);
    for (const a of s.avatars) this.addAvatar(a, true);
    for (const cmd of s.active_commands) {
      const ctl = this.avatars.get(cmd.avatar_id);
      if (ctl && ctl.cmd?.command_id !== cmd.command_id) ctl.receiveAction(cmd);
      else if (ctl) this.emit({ type: "ACK", command_id: cmd.command_id });
    }
    this.camera = { mode: s.camera.mode, avatarId: s.camera.avatar_id ?? null, commandId: s.camera.command_id ?? null };
    if (s.stage !== undefined) this.setStage(s.stage ?? null, true);
    this.version++;
  }

  /** Stage line from the server; after a reload the dancer goes back up. */
  /** The camera frames the stage while a Chibi is up there dancing. */
  stageShot(): boolean {
    const cur = this.stage?.current;
    if (!this.stageSpot || !cur?.avatar_id) return false;
    const a = this.avatars.get(cur.avatar_id);
    return !!a && !a.removed && (a.phase === "stage_dance" || a.phase === "stage_up");
  }

  private setStage(v: StageView | null, resume = false): void {
    this.stage = v;
    const cur = v?.current;
    if (resume && cur?.sent && cur.avatar_id && this.stageSpot) {
      this.avatars.get(cur.avatar_id)?.goOnStage(this.stageSpot, cur.token, v!.seconds);
    }
  }

  handle(m: ServerGameMessage): void {
    switch (m.type) {
      case "AVATAR_SPAWN":
        this.addAvatar(m.avatar);
        break;
      case "AVATAR_UPDATE": {
        const a = this.avatars.get(m.avatar.avatar_id);
        if (a) {
          a.info = m.avatar;
          this.version++;
        }
        break;
      }
      case "AVATAR_EXIT":
        this.avatars.get(m.avatar_id)?.exit();
        break;
      case "CHARACTER_ACTION": {
        const ctl = this.avatars.get(m.avatar_id);
        if (ctl) ctl.receiveAction(m);
        else this.emit({ type: "ACTION_FAILED", command_id: m.command_id, reason: "unknown_avatar" });
        break;
      }
      case "PREEMPT":
        this.avatars.get(m.avatar_id)?.requestPreempt(m.command_id);
        break;
      case "WAIT_NEAR_SHELF":
        this.avatars.get(m.avatar_id)?.waitNear(m.shelf_id, m.wait_index, m.command_id);
        break;
      case "RESET_AVATAR":
        this.avatars.get(m.avatar_id)?.reset(m.reason);
        break;
      case "CAMERA_FOCUS":
        this.camera = { mode: m.mode, avatarId: m.avatar_id ?? null, commandId: m.command_id ?? null };
        break;
      case "SOCIAL_EFFECT":
        if (m.avatar_id) this.avatars.get(m.avatar_id)?.effect(m.kind);
        break;
      case "LAYOUT_UPDATED":
        this.setLayout(m.layout);
        break;
      case "SCENE_UPDATED":
        this.setScene(m.scene);
        break;
      case "OWNER_GREET":
        if (this.scene.owner_enabled) this.tea.greet(m.text);
        break;
      case "OWNER_TEA":
        if (this.scene.owner_enabled) this.tea.invite(m.avatar_id, m.name, m.text);
        break;
      case "OWNER_THANKS":
        if (this.scene.owner_enabled) this.tea.thanks(m.text);
        break;
      case "OWNER_SAY":
        if (this.scene.owner_enabled) this.tea.line(m.text, m.kind === "stage" ? "stage" : "talk");
        break;
      case "STAGE_STATE":
        this.setStage(m.stage);
        break;
      case "STAGE_PERFORM": {
        const ctl = this.avatars.get(m.avatar_id);
        if (!ctl || !this.stageSpot || !ctl.goOnStage(this.stageSpot, m.token, m.seconds))
          this.emit({ type: "STAGE_PROGRESS", token: m.token, phase: "failed" });
        break;
      }
      case "STAGE_END":
        this.avatars.get(m.avatar_id)?.leaveStage(m.token);
        break;
      case "LEADERBOARD":
        this.board = m.board;
        this.boardVersion++;
        break;
      case "LIVE_STATUS":
        this.liveStatus = m.status;
        this.isDemo = m.is_demo;
        this.version++;
        break;
      case "SESSION":
        this.sessionId = m.session_id;
        this.isDemo = m.is_demo;
        for (const a of this.avatars.values()) a.exit();
        this.version++;
        break;
      default:
        break;
    }
  }

  step(dt: number): void {
    // A slow PC (or a busy OBS) may render only a few frames a second: the simulation still
    // runs in real time, in small sub-steps so nobody skips through a shelf. A long pause
    // (tab in background) is capped so characters never teleport.
    let left = Math.min(dt, 0.5);
    while (left > 1e-4) {
      const h = Math.min(left, 0.1);
      left -= h;
      for (const [id, a] of this.avatars) {
        a.update(h);
        if (a.removed) {
          this.avatars.delete(id);
          this.version++;
        }
      }
      this.tea.update(h, this.spot);
    }
  }

  focused(): AvatarController | null {
    if (this.camera.mode !== "follow" || !this.camera.avatarId) return null;
    return this.avatars.get(this.camera.avatarId) ?? null;
  }

  /** Product card shown while the focused avatar is showing a product (GAME-10). */
  showcase(): { product: ProductInfo; avatar: AvatarController } | null {
    const a = this.focused();
    if (!a || !a.held || a.phase !== "show") return null;
    const p = this.products.get(a.held.productId);
    return p ? { product: p, avatar: a } : null;
  }

  debugState() {
    return {
      sessionId: this.sessionId,
      isDemo: this.isDemo,
      liveStatus: this.liveStatus,
      layoutVersion: this.layoutVersion,
      scene: { theme: this.scene.theme, banner: this.scene.banner_enabled, sceneVersion: this.sceneVersion },
      tea: {
        pose: this.tea.pose,
        bubble: this.tea.bubble?.text ?? null,
        guest: this.tea.guest ? { avatarId: this.tea.guest.avatarId, seated: this.tea.guest.seatedAt !== null, served: this.tea.guest.served } : null,
        queue: this.tea.queue.length,
        cupFull: this.tea.guestCupFull,
        teaShot: this.tea.cameraOnTable(),
        stageShot: this.stageShot(),
        spot: this.spot ? { x: this.spot.table.x, z: this.spot.table.z } : null,
        history: this.tea.history.slice(-10),
      },
      led: this.led,
      board: this.board ? { gifts: this.board.gifts.length, buyers: this.board.buyers.length } : null,
      camera: { ...this.camera, phase: this.focused()?.phase ?? null },
      avatars: [...this.avatars.values()].map((a) => ({
        id: a.info.avatar_id,
        nickname: a.info.nickname,
        state: a.state,
        phase: a.phase,
        commandId: a.cmd?.command_id ?? null,
        heldProductId: a.held?.productId ?? null,
        heldMode: a.held?.mode ?? null,
        pos: { x: +a.pos.x.toFixed(2), z: +a.pos.z.toFixed(2) },
        completed: [...a.completed],
        lastFailure: a.lastFailure,
        top: a.topState,
        behavior: a.behaviorId,
        history: a.history.slice(-12),
        directQueue: a.direct.map((d) => d.kind),
        emote: a.emote?.icon ?? null,
        seat: a.sittingOnBench?.id ?? null,
        pose: a.pose,
        elevation: +a.elevation.toFixed(2),
      })),
      clipWarnings: [...this.clips.warnings],
      stage: this.stage ? { current: this.stage.current, waiting: this.stage.waiting, queue: this.stage.queue.map((q) => q.name) } : null,
      stageSpot: this.stageSpot ? { x: this.stageSpot.center.x, z: this.stageSpot.center.z } : null,
      ownerTalking: this.tea.talking,
      hostSpeaking: this.hostSpeaking,
      behaviorConfig: this.behavior,
      lod: { ...this.lod, level: this.lodLevel },
      seats: Object.fromEntries([...this.benches.flatMap((b) => b.seats)].map((s) => [s.id, this.world.seatFree?.(s.id) === false])),
      sent: this.sent.slice(-80),
    };
  }
}

/** Behaviour settings saved in the dashboard (scene config) → scheduler config. */
export function behaviorFromScene(sc: SceneConfig): BehaviorConfig {
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : d);
  const w = DEFAULT_BEHAVIOR.weights;
  return {
    ...DEFAULT_BEHAVIOR,
    autonomous_enabled: sc.chibi_autonomous ?? true,
    weights: {
      browse: n(sc.chibi_w_browse, w.browse),
      explore: n(sc.chibi_w_explore, w.explore),
      idle: n(sc.chibi_w_idle, w.idle),
      social: n(sc.chibi_w_social, w.social),
      rest: n(sc.chibi_w_rest, w.rest),
      fun: n(sc.chibi_w_fun, w.fun),
    },
  };
}
