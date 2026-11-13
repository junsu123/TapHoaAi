// Animation state machine (GAME-05). Every state has a maximum duration, so no command
// can leave a Chibi stuck forever; the controller decides what happens on expiry.

export type AnimState =
  | "idle"
  | "walk"
  | "wave"
  | "inspect"
  | "pickup"
  | "hold"
  | "show"
  | "return"
  | "wait"
  | "checkout"
  | "exit"
  | "dance"
  | "celebrate";

/** Max seconds per state (Infinity = until the controller changes it). */
export const MAX_DURATION: Record<AnimState, number> = {
  idle: Infinity,
  walk: 25,
  wave: 1.4,
  inspect: 0.8,
  pickup: 0.6,
  hold: 0.4,
  show: 30,
  return: 0.7,
  wait: 45,
  checkout: 3,
  exit: 25,
  dance: 3,
  celebrate: 1.6,
};

const ALLOWED: Record<AnimState, AnimState[]> = {
  idle: ["walk", "wave", "dance", "celebrate", "wait", "exit", "inspect"],
  walk: ["idle", "inspect", "wait", "exit", "walk", "return"],
  wave: ["idle", "walk"],
  inspect: ["pickup", "idle", "walk"],
  pickup: ["hold", "return", "idle"],
  hold: ["show", "return", "idle"],
  show: ["return", "idle"],
  return: ["idle", "walk"],
  wait: ["walk", "idle", "inspect"],
  checkout: ["idle", "walk", "exit"],
  exit: ["idle"],
  dance: ["idle", "walk"],
  celebrate: ["idle", "walk"],
};

export class AnimationFSM {
  state: AnimState = "idle";
  elapsed = 0;
  history: AnimState[] = [];

  canGo(next: AnimState): boolean {
    return ALLOWED[this.state].includes(next);
  }

  /** Strict transition; returns false (and stays) when not allowed. */
  go(next: AnimState): boolean {
    if (!this.canGo(next)) return false;
    this.force(next);
    return true;
  }

  /** Error recovery path: always allowed. */
  force(next: AnimState): void {
    this.state = next;
    this.elapsed = 0;
    this.history.push(next);
    if (this.history.length > 50) this.history.shift();
  }

  /** Advances time; returns true when the state exceeded its max duration. */
  tick(dt: number): boolean {
    this.elapsed += dt;
    return this.elapsed > MAX_DURATION[this.state];
  }
}
