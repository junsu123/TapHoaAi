// Client-side game state: applies server messages, steps avatar controllers every frame,
// decides the camera framing. Rendering components read from here without re-rendering
// React on every frame.

import type {
  AvatarInfo,
  ClientGameMessage,
  GameSnapshot,
  Point2,
  ProductInfo,
  ServerGameMessage,
  ShelfLayout,
  StoreLayout,
} from "../types/protocol";
import { AvatarController, type Vec3, type WorldQuery } from "./AvatarController";
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
    };
  }

  private emit = (m: ClientGameMessage): void => {
    this.sent.push(m);
    if (this.sent.length > 300) this.sent.shift();
    this.send(m);
  };

  setLayout(layout: StoreLayout): void {
    this.layout = layout;
    this.layoutVersion = layout.version;
    this.nav = new NavGrid(layout);
    this.world.nav = this.nav;
    this.world.door = { x: layout.store.door.x, z: Math.min(layout.store.door.z, layout.store.depth / 2 - 0.6) };
    this.products = new Map(layout.products.map((p) => [p.id, p]));
    this.shelves = new Map(layout.shelves.map((s) => [s.code, s]));
    this.version++;
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
    if (existing && !existing.removed && existing.phase !== "exiting") {
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
    const keep = new Set(s.avatars.map((a) => a.avatar_id));
    for (const id of [...this.avatars.keys()]) if (!keep.has(id)) this.avatars.delete(id);
    for (const a of s.avatars) this.addAvatar(a, true);
    for (const cmd of s.active_commands) {
      const ctl = this.avatars.get(cmd.avatar_id);
      if (ctl && ctl.cmd?.command_id !== cmd.command_id) ctl.receiveAction(cmd);
      else if (ctl) this.emit({ type: "ACK", command_id: cmd.command_id });
    }
    this.camera = { mode: s.camera.mode, avatarId: s.camera.avatar_id ?? null, commandId: s.camera.command_id ?? null };
    this.version++;
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
    const clamped = Math.min(dt, 0.1); // tab switches must not teleport characters
    for (const [id, a] of this.avatars) {
      a.update(clamped);
      if (a.removed) {
        this.avatars.delete(id);
        this.version++;
      }
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
      })),
      sent: this.sent.slice(-80),
    };
  }
}
