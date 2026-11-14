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

/** The parts of window.speechSynthesis we use (injectable for tests). */
export interface SynthLike {
  speak(u: UtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): VoiceLike[];
}
export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
}
export interface UtteranceLike {
  text: string;
  voice: VoiceLike | null;
  lang: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}

const isVi = (v: VoiceLike) => (v.lang || "").toLowerCase().replace("_", "-").startsWith("vi");

/** The computer's Vietnamese voice: the one named in the settings, else a natural one, else any. */
export function pickVoice(voices: VoiceLike[], name: string | null | undefined): VoiceLike | null {
  if (name) {
    const v = voices.find((x) => x.name === name);
    if (v) return v;
  }
  const vi = voices.filter(isVi);
  return vi.find((v) => /natural/i.test(v.name)) ?? vi.find((v) => v.localService) ?? vi[0] ?? null;
}

export function vietnameseVoices(voices: VoiceLike[]): VoiceLike[] {
  return voices.filter(isVi);
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
  private utter: UtteranceLike | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: {
      audible: boolean;
      emit: (m: ClientGameMessage) => void;
      onChange: (v: SpeechView) => void;
      makeAudio?: (url: string) => AudioLike;
      synth?: SynthLike | null;
      makeUtterance?: (text: string) => UtteranceLike;
    },
  ) {}

  private synth(): SynthLike | null {
    if (this.opts.synth !== undefined) return this.opts.synth;
    return typeof window !== "undefined" && "speechSynthesis" in window ? (window.speechSynthesis as unknown as SynthLike) : null;
  }

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
    if (this.utter) {
      this.utter.onstart = this.utter.onend = null;
      this.utter.onerror = null;
      this.utter = null;
      this.synth()?.cancel();
    }
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
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
    if (this.opts.audible && !clip.url && clip.fallback && this.speakLocal(clip)) return;
    if (!this.opts.audible || !clip.url) {
      this.showSilently(clip);
      return;
    }
    const a = (this.opts.makeAudio ?? ((url: string) => new Audio(url) as AudioLike))(clip.url);
    this.audio = a;
    a.onended = () => this.finish(true);
    a.onerror = () => this.finish(false, "audio_error");
    if (!this.held) this.tryPlay();
  }

  /** Preview page, or no voice at all: show the caption about as long as it would take to say it;
   * the OBS page still reports start/end so the next line follows. */
  private showSilently(clip: SpeechClip, started = false) {
    if (this.opts.audible && !started) this.opts.emit({ type: "SPEECH_STARTED", id: clip.id });
    this.silentTimer = setTimeout(() => {
      this.silentTimer = null;
      if (this.opts.audible) this.finish(true);
      else {
        this.clip = null;
        this.changed();
      }
    }, 1500 + clip.text.length * 70);
  }

  /** No Vbee audio: read the line with the computer's own Vietnamese voice. False = no such voice. */
  private speakLocal(clip: SpeechClip): boolean {
    const synth = this.synth();
    if (!synth || !clip.fallback) return false;
    const voice = pickVoice(synth.getVoices(), clip.fallback.name);
    if (!voice) return false;
    const u = this.opts.makeUtterance
      ? this.opts.makeUtterance(clip.text)
      : (new SpeechSynthesisUtterance(clip.text) as unknown as UtteranceLike);
    u.voice = voice;
    u.lang = voice.lang || clip.fallback.lang;
    u.rate = clip.fallback.rate || 1;
    let started = false;
    u.onstart = () => {
      if (started || this.utter !== u) return;
      started = true;
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = null;
      if (this.blocked) {
        this.blocked = false;
        this.changed();
      }
      this.opts.emit({ type: "SPEECH_STARTED", id: clip.id });
    };
    u.onend = () => {
      if (this.utter === u) this.finish(true);
    };
    u.onerror = (e) => {
      if (this.utter !== u) return;
      if (e?.error === "not-allowed") {
        // a normal browser tab without a click yet (OBS never blocks): ask for one, keep the caption
        this.blocked = true;
        this.changed();
        return;
      }
      if (e?.error === "interrupted" || e?.error === "canceled") return;
      this.utter = null;
      this.showSilently(clip, started);
    };
    this.utter = u;
    synth.cancel();
    synth.speak(u);
    if (this.held) synth.pause();
    // some machines accept the line but never start it: fall back to the caption
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.utter === u && !started && !this.held && !this.blocked) {
        this.utter = null;
        synth.cancel();
        this.showSilently(clip);
      }
    }, 5000);
    return true;
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
    if (!this.blocked) return;
    if (this.utter) {
      const synth = this.synth();
      synth?.cancel();
      synth?.speak(this.utter);
    } else this.tryPlay();
  }

  hold(on: boolean): void {
    const was = this.held;
    this.held = on;
    if (this.utter) {
      const synth = this.synth();
      if (on) synth?.pause();
      else if (was) synth?.resume();
    }
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
