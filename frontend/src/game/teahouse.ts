// The tea table in the middle of the shop: the shop-owner Chibi brews tea there, stands up and
// bows to greet new viewers (speech bubble), and serves tea to whoever sends a gift — the gift
// giver's Chibi walks over, sits opposite the owner, drinks, then goes back to browsing.
// Pure logic (no three.js) so it can be unit-tested.

import type { Point2, StoreLayout } from "../types/protocol";

export interface TeaSpot {
  table: Point2; // centre of the low table
  tableW: number; // along x
  tableD: number; // along z
  owner: Point2; // owner's cushion (left)
  ownerYaw: number;
  guest: Point2; // guest cushion (right, opposite the owner)
  guestYaw: number;
  guestApproach: Point2; // free cell in front of the guest cushion
  obstacle: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** The tea corner sits in the centre aisle, between the first two rows of shelves — or, when the
 * dance stage takes the middle of the shop, further back, just in front of the counter. */
export function teaSpot(layout: StoreLayout, roomForStage = false): TeaSpot {
  const c = layout.store.counter;
  const front = c.z + c.d / 2;
  // halfway between the counter and the middle of the shop, never too close to the counter
  const z = roomForStage ? front + 2.2 : Math.max(front + 1.6, Math.min(front + 4.6, (front + 0) / 2 + 1.2));
  const x = c.x;
  const turn = 0.35; // both sit slightly turned towards the main camera
  return {
    table: { x, z },
    tableW: 0.9,
    tableD: 0.6,
    owner: { x: x - 0.72, z },
    ownerYaw: Math.PI / 2 - turn,
    guest: { x: x + 0.72, z },
    guestYaw: -Math.PI / 2 + turn,
    guestApproach: { x: x + 0.9, z: z + 1.05 },
    obstacle: { minX: x - 1.05, maxX: x + 1.05, minZ: z - 0.4, maxZ: z + 0.4 },
  };
}

export type OwnerPose = "brew" | "rise" | "bow" | "stand" | "sit" | "serve" | "offer";

export interface Bubble {
  text: string;
  kind: "greet" | "tea" | "thanks" | "talk" | "stage" | "poem" | "story" | "game";
  until: number;
}

export interface TeaGuest {
  avatarId: string;
  name: string;
  text: string;
  since: number; // queued at
}

const POSE_SECONDS: Record<OwnerPose, number> = {
  brew: Infinity,
  rise: 0.45,
  bow: 1.3,
  stand: 2.2,
  sit: 0.45,
  serve: 2.4,
  offer: 2.2,
};
export const BUBBLE_SECONDS = { greet: 4.2, tea: 6, thanks: 4.5, talk: 30, stage: 4.5, poem: 40, story: 40, game: 9 };
/** a short owner line said while the voice was talking is shown when it stops, if still this fresh */
const LINE_WAIT_S = 20;
export const GUEST_SIT_SECONDS = 12;
const GUEST_WAIT_MAX = 25; // give up inviting a busy / vanished Chibi after this long
const QUEUE_MAX = 6;

/** Minimal view of an avatar the tea house needs (implemented by AvatarController). */
export interface TeaVisitor {
  readonly removed: boolean;
  readonly busy: boolean;
  readonly phase: string;
  visitTea(spot: TeaSpot): boolean;
  leaveTea(): void;
}

export class TeaHouse {
  pose: OwnerPose = "brew";
  poseT = 0;
  /** 0 = seated, 1 = standing (smoothed by the renderer) */
  bubble: Bubble | null = null;
  guest: (TeaGuest & { seatedAt: number | null; served: boolean }) | null = null;
  queue: TeaGuest[] = [];
  /** the LIVE voice is speaking right now (the owner talks: head and hands move) */
  talking = false;
  /** cups on the table: the guest's cup is filled when served */
  guestCupFull = false;
  private pendingGreet: string[] = [];
  private pendingLine: { text: string; kind: "stage" | "talk" | "game"; at: number } | null = null;
  private now = 0;
  history: { kind: string; text: string; at: number }[] = [];

  constructor(private find: (avatarId: string) => TeaVisitor | undefined) {}

  // ------------------------------------------------------------------ inputs
  greet(text: string): void {
    // a new greeting while bowing: show it right after
    if (this.bubble?.kind === "greet" && this.pose !== "brew" && this.pose !== "serve" && this.pose !== "offer") {
      this.pendingGreet.push(text);
      return;
    }
    this.say(text, "greet");
    if (this.pose === "brew") this.setPose("rise");
  }

  /** A short line in the bubble (stage calls, thanks…) without standing up. */
  line(text: string, kind: "stage" | "talk" | "game" = "talk"): void {
    if (this.talking) {
      // the voice is speaking: its words stay in the bubble; this line follows right after
      this.pendingLine = { text, kind, at: this.now };
      return;
    }
    this.say(text, kind === "stage" ? "stage" : kind === "game" ? "game" : "thanks");
  }

  /** The owner speaks (every line of the LIVE voice): the bubble shows it while it plays. */
  talk(text: string, kind: string): void {
    this.talking = true;
    const k: Bubble["kind"] = kind === "poem" ? "poem" : kind === "story" ? "story" : kind === "stage" ? "stage" : "talk";
    this.say(bubbleText(text, k), k);
  }

  /** The voice line ended. */
  stopTalk(): void {
    if (!this.talking) return;
    this.talking = false;
    const next = this.pendingLine;
    this.pendingLine = null;
    if (next && this.now - next.at <= LINE_WAIT_S) {
      this.say(next.text, next.kind === "stage" ? "stage" : next.kind === "game" ? "game" : "thanks");
      return;
    }
    if (this.bubble && (this.bubble.kind === "talk" || this.bubble.kind === "poem" || this.bubble.kind === "story" || this.bubble.kind === "stage"))
      this.bubble.until = Math.min(this.bubble.until, this.now + 1.2); // fade out shortly after
  }

  thanks(text: string): void {
    this.say(text, "thanks");
    if (this.pose === "brew") this.setPose("rise");
  }

  /** A gift: invite the giver's Chibi to the table (or just thank them if they have none). */
  invite(avatarId: string | null, name: string, text: string): void {
    if (!avatarId || !this.find(avatarId)) {
      this.say(text, "tea");
      if (this.pose === "brew") this.setPose("offer");
      return;
    }
    if (this.guest?.avatarId === avatarId || this.queue.some((q) => q.avatarId === avatarId)) return;
    if (this.queue.length >= QUEUE_MAX) {
      this.say(text, "tea");
      return;
    }
    this.queue.push({ avatarId, name, text, since: this.now });
  }

  // ------------------------------------------------------------------ frame update
  update(dt: number, spot: TeaSpot | null): void {
    this.now += dt;
    this.poseT += dt;
    if (this.bubble && this.now > this.bubble.until) {
      this.bubble = null;
      const next = this.pendingGreet.shift();
      if (next) this.greet(next);
    }
    // owner pose sequence
    if (this.poseT >= POSE_SECONDS[this.pose]) {
      if (this.pose === "rise") this.setPose("bow");
      else if (this.pose === "bow") this.setPose("stand");
      else if (this.pose === "stand") this.setPose(this.pendingGreet.length ? "stand" : "sit");
      else if (this.pose === "sit") this.setPose("brew");
      else if (this.pose === "serve") this.setPose("offer");
      else if (this.pose === "offer") this.setPose("brew");
    }
    if (!spot) return;
    // the guest seat
    const g = this.guest;
    if (g) {
      const v = this.find(g.avatarId);
      if (!v || v.removed) {
        this.endGuest(false);
      } else if (g.seatedAt === null) {
        if (v.phase === "tea_sit") {
          g.seatedAt = this.now;
          this.say(g.text, "tea");
          this.setPose("serve");
        } else if (this.now - g.since > GUEST_WAIT_MAX || (v.phase !== "to_tea" && v.phase !== "tea_step")) {
          this.say(g.text, "tea"); // could not get to the table: thank from afar
          this.endGuest(false);
        }
      } else if (v.phase !== "tea_sit") {
        this.endGuest(false); // called away (e.g. to show a product)
      } else {
        if (!g.served && this.pose === "offer") {
          g.served = true;
          this.guestCupFull = true;
        }
        if (this.now - g.seatedAt > GUEST_SIT_SECONDS) {
          v.leaveTea();
          this.endGuest(true);
        }
      }
    }
    if (!this.guest) this.nextGuest(spot);
  }

  /** Close the camera in on the table while tea is served. */
  cameraOnTable(): boolean {
    const g = this.guest;
    return !!g && g.seatedAt !== null && this.now - g.seatedAt < 7;
  }

  // ------------------------------------------------------------------ helpers
  private nextGuest(spot: TeaSpot): void {
    while (this.queue.length) {
      const q = this.queue[0];
      const v = this.find(q.avatarId);
      if (!v || v.removed || this.now - q.since > GUEST_WAIT_MAX) {
        this.queue.shift();
        this.say(q.text, "tea");
        continue;
      }
      if (v.busy) return; // showing a product right now: invite when done
      this.queue.shift();
      if (v.visitTea(spot)) {
        this.guest = { ...q, since: this.now, seatedAt: null, served: false };
        this.guestCupFull = false;
      } else {
        this.say(q.text, "tea");
      }
      return;
    }
  }

  private endGuest(_ok: boolean): void {
    this.guest = null;
    this.guestCupFull = false;
  }

  private say(text: string, kind: Bubble["kind"]): void {
    this.bubble = { text, kind, until: this.now + BUBBLE_SECONDS[kind] };
    this.history.push({ kind, text, at: this.now });
    if (this.history.length > 30) this.history.shift();
  }

  private setPose(p: OwnerPose): void {
    this.pose = p;
    this.poseT = 0;
  }

  /** 0 seated … 1 standing, for the renderer. */
  standing(): number {
    const t = this.poseT;
    switch (this.pose) {
      case "rise":
        return Math.min(1, t / POSE_SECONDS.rise);
      case "bow":
      case "stand":
        return 1;
      case "sit":
        return Math.max(0, 1 - t / POSE_SECONDS.sit);
      default:
        return 0;
    }
  }

  /** Forward bow angle (radians). */
  bowAngle(): number {
    if (this.pose !== "bow") return 0;
    const k = this.poseT / POSE_SECONDS.bow;
    return Math.sin(Math.min(1, k) * Math.PI) * 0.75;
  }
}

/** What the speech bubble shows for a spoken line: poems keep their lines; long lines are cut. */
export function bubbleText(text: string, kind: Bubble["kind"]): string {
  const t = text.trim();
  if (kind === "poem") return t.split("\n").slice(0, 6).join("\n");
  if (kind === "story") {
    const lines = t.split("\n");
    const body = lines.length > 1 ? lines.slice(1).join(" ") : t;
    const first = body.split(/(?<=[.!?])\s/)[0] ?? body;
    return `📖 ${first.length > 110 ? first.slice(0, 108) + "…" : first}`;
  }
  return t.length > 140 ? t.slice(0, 138).replace(/\s+\S*$/, "") + "…" : t;
}
