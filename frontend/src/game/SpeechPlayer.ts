// Plays the LIVE voice on the OBS page (role=primary) and tells the server when each clip starts
// and ends, so the next one never overlaps. Preview pages (role=viewer) only show the caption.
// SPEECH_HOLD pauses the clip while the host talks; SPEECH_STOP is the kill switch.

import type { ClientGameMessage, SpeechClip } from "../types/protocol";

export interface AudioLike {
  play(): Promise<void>;
  pause(): void;
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SpeechView {
  clip: SpeechClip | null;
  held: boolean;
  blocked: boolean; // the browser refused autoplay: a click is needed (never in OBS)
}

type SpeechMsg = { type: "SPEECH"; clip: SpeechClip } | { type: "SPEECH_STOP" } | { type: "SPEECH_HOLD"; hold: boolean };

export class SpeechPlayer {
  private audio: AudioLike | null = null;
  private clip: SpeechClip | null = null;
  private held = false;
  private blocked = false;
  private silentTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: {
      audible: boolean;
      emit: (m: ClientGameMessage) => void;
      onChange: (v: SpeechView) => void;
      makeAudio?: (url: string) => AudioLike;
    },
  ) {}

  view(): SpeechView {
    return { clip: this.clip, held: this.held, blocked: this.blocked };
  }

  private changed() {
    this.opts.onChange(this.view());
  }

  handle(m: SpeechMsg): void {
    if (m.type === "SPEECH") this.start(m.clip);
    else if (m.type === "SPEECH_STOP") this.stop();
    else if (m.type === "SPEECH_HOLD") this.hold(m.hold);
  }

  private release() {
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    if (this.silentTimer) clearTimeout(this.silentTimer);
    this.silentTimer = null;
  }

  private finish(ok: boolean, reason?: string) {
    const c = this.clip;
    this.release();
    this.clip = null;
    this.blocked = false;
    this.changed();
    if (c && this.opts.audible) this.opts.emit(ok ? { type: "SPEECH_ENDED", id: c.id } : { type: "SPEECH_FAILED", id: c.id, reason: reason ?? "error" });
  }

  start(clip: SpeechClip): void {
    this.release();
    this.clip = clip;
    this.blocked = false;
    this.changed();
    if (!this.opts.audible || !clip.url) {
      // preview page, or no voice (Vbee not set up / failing): show the caption about as long as
      // it would take to say it; the OBS page still reports start/end so the next line follows
      if (this.opts.audible) this.opts.emit({ type: "SPEECH_STARTED", id: clip.id });
      this.silentTimer = setTimeout(() => {
        this.silentTimer = null;
        if (this.opts.audible) this.finish(true);
        else {
          this.clip = null;
          this.changed();
        }
      }, 1500 + clip.text.length * 70);
      return;
    }
    const a = (this.opts.makeAudio ?? ((url: string) => new Audio(url) as AudioLike))(clip.url);
    this.audio = a;
    a.onended = () => this.finish(true);
    a.onerror = () => this.finish(false, "audio_error");
    if (!this.held) this.tryPlay();
  }

  private tryPlay() {
    const a = this.audio;
    const c = this.clip;
    if (!a || !c) return;
    a.play().then(
      () => {
        if (this.blocked) {
          this.blocked = false;
          this.changed();
        }
        this.opts.emit({ type: "SPEECH_STARTED", id: c.id });
      },
      (err: unknown) => {
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          this.blocked = true;
          this.changed();
        } else if (this.audio === a) this.finish(false, "play_failed");
      },
    );
  }

  /** User gesture on a normal browser tab (OBS does not need it). */
  unlock(): void {
    if (this.blocked) this.tryPlay();
  }

  hold(on: boolean): void {
    this.held = on;
    if (this.audio) {
      if (on) this.audio.pause();
      else this.tryPlay();
    }
    this.changed();
  }

  stop(): void {
    this.release();
    this.clip = null;
    this.blocked = false;
    this.changed();
  }
}
