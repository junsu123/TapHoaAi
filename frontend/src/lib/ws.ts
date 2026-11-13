// Sequenced WebSocket client: snapshot first, then strictly increasing sequence numbers.
// A gap triggers RESYNC (new snapshot) instead of guessing state (SPEC F3).

export type SeqDecision = "apply" | "ignore" | "buffer" | "resync";

/** Pure sequencing logic (unit-tested). */
export class SequenceTracker {
  lastSeq = -1;
  haveSnapshot = false;
  private buffer: { seq: number; msg: unknown }[] = [];

  onSnapshot(seq: number): unknown[] {
    this.lastSeq = seq;
    this.haveSnapshot = true;
    const ready = this.buffer
      .filter((b) => b.seq > seq)
      .sort((a, b) => a.seq - b.seq);
    this.buffer = [];
    const out: unknown[] = [];
    for (const b of ready) {
      if (b.seq === this.lastSeq + 1) {
        this.lastSeq = b.seq;
        out.push(b.msg);
      } else {
        this.haveSnapshot = false; // gap inside the buffer → need another snapshot
        break;
      }
    }
    return out;
  }

  decide(seq: number, msg: unknown): SeqDecision {
    if (!this.haveSnapshot) {
      this.buffer.push({ seq, msg });
      if (this.buffer.length > 500) this.buffer.shift();
      return "buffer";
    }
    if (seq <= this.lastSeq) return "ignore";
    if (seq === this.lastSeq + 1) {
      this.lastSeq = seq;
      return "apply";
    }
    this.haveSnapshot = false;
    this.buffer = [{ seq, msg }];
    return "resync";
  }

  reset(): void {
    this.lastSeq = -1;
    this.haveSnapshot = false;
    this.buffer = [];
  }
}

export interface SocketHandlers<S, M> {
  onSnapshot: (snap: S) => void;
  onMessage: (msg: M) => void;
  onStatus?: (connected: boolean) => void;
}

export class SequencedSocket<S extends { type: string; sequence: number }, M extends { type: string; sequence?: number }> {
  private ws: WebSocket | null = null;
  private tracker = new SequenceTracker();
  private closed = false;
  private retry = 0;
  private lastMessageAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  connected = false;

  constructor(private url: string, private handlers: SocketHandlers<S, M>) {}

  start(): void {
    this.closed = false;
    this.open();
    this.heartbeat = setInterval(() => this.beat(), 5000);
  }

  stop(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private beat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessageAt > 35_000) {
      this.ws.close(); // two missed heartbeats → reconnect
      return;
    }
    if (Date.now() - this.lastMessageAt > 15_000) this.send({ type: "PING" });
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.tracker.reset();
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.lastMessageAt = Date.now();
      this.handlers.onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: S | M;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "SNAPSHOT") {
        const pending = this.tracker.onSnapshot((msg as S).sequence);
        this.handlers.onSnapshot(msg as S);
        for (const m of pending) this.handlers.onMessage(m as M);
        if (!this.tracker.haveSnapshot) this.send({ type: "RESYNC" });
        return;
      }
      const seq = (msg as M).sequence;
      if (typeof seq !== "number") {
        this.handlers.onMessage(msg as M); // un-sequenced (PONG)
        return;
      }
      const d = this.tracker.decide(seq, msg);
      if (d === "apply") this.handlers.onMessage(msg as M);
      else if (d === "resync") this.send({ type: "RESYNC" });
    };
    ws.onclose = () => {
      this.connected = false;
      this.handlers.onStatus?.(false);
      if (this.closed) return;
      const delay = Math.min(8000, 500 * 2 ** this.retry) * (0.5 + Math.random() / 2);
      this.retry += 1;
      setTimeout(() => !this.closed && this.open(), delay);
    };
  }
}

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}
