import { describe, expect, it, vi } from "vitest";
import type { ClientGameMessage, SpeechClip } from "../types/protocol";
import { pickVoice, SpeechPlayer, type AudioLike, type UtteranceLike, type VoiceLike } from "./SpeechPlayer";

class FakeAudio implements AudioLike {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playing = false;
  constructor(
    url: string,
    private readonly refuse = false,
  ) {
    this.src = url;
  }
  play() {
    if (this.refuse) return Promise.reject(new DOMException("no gesture", "NotAllowedError"));
    this.playing = true;
    return Promise.resolve();
  }
  pause() {
    this.playing = false;
  }
}

const clip = (id: string, kind: SpeechClip["kind"] = "question"): SpeechClip => ({ id, kind, label: "x", text: "Bạn A hỏi: giá bao nhiêu", url: `/tts/${id}.mp3` });
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { audible?: boolean; refuse?: boolean } = {}) {
  const sent: ClientGameMessage[] = [];
  const audios: FakeAudio[] = [];
  let refuse = opts.refuse ?? false;
  const p = new SpeechPlayer({
    audible: opts.audible ?? true,
    emit: (m) => sent.push(m),
    onChange: () => undefined,
    makeAudio: (url) => {
      const a = new FakeAudio(url, refuse);
      audios.push(a);
      return a;
    },
  });
  return { p, sent, audios, allow: () => (refuse = false) };
}

describe("SpeechPlayer", () => {
  it("reports start and end of each clip and clears the caption", async () => {
    const { p, sent, audios } = setup();
    p.handle({ type: "SPEECH", clip: clip("s1") });
    await tick();
    expect(sent).toEqual([{ type: "SPEECH_STARTED", id: "s1" }]);
    expect(p.view().clip?.id).toBe("s1");
    audios[0].onended!();
    expect(sent.at(-1)).toEqual({ type: "SPEECH_ENDED", id: "s1" });
    expect(p.view().clip).toBeNull();
  });

  it("pauses while the host talks and resumes after", async () => {
    const { p, audios } = setup();
    p.handle({ type: "SPEECH", clip: clip("s1") });
    await tick();
    p.handle({ type: "SPEECH_HOLD", hold: true });
    expect(audios[0].playing).toBe(false);
    p.handle({ type: "SPEECH_HOLD", hold: false });
    await tick();
    expect(audios[0].playing).toBe(true);
  });

  it("kill switch stops at once without reporting an end", async () => {
    const { p, sent, audios } = setup();
    p.handle({ type: "SPEECH", clip: clip("s1") });
    await tick();
    p.handle({ type: "SPEECH_STOP" });
    expect(audios[0].playing).toBe(false);
    expect(p.view().clip).toBeNull();
    expect(sent.map((m) => m.type)).toEqual(["SPEECH_STARTED"]);
  });

  it("asks for a click when the browser blocks autoplay", async () => {
    const { p, sent, audios } = setup({ refuse: true });
    p.handle({ type: "SPEECH", clip: clip("s1") });
    await tick();
    expect(p.view().blocked).toBe(true);
    expect(sent).toEqual([]);
    (audios[0] as unknown as { refuse: boolean }).refuse = false;
    p.unlock();
    await tick();
    expect(p.view().blocked).toBe(false);
    expect(sent).toEqual([{ type: "SPEECH_STARTED", id: "s1" }]);
  });

  it("preview pages show the caption but never play or report", async () => {
    vi.useFakeTimers();
    const { p, sent, audios } = setup({ audible: false });
    p.handle({ type: "SPEECH", clip: clip("s1", "answer") });
    expect(p.view().clip?.kind).toBe("answer");
    vi.advanceTimersByTime(10_000);
    expect(p.view().clip).toBeNull();
    expect(audios).toHaveLength(0);
    expect(sent).toEqual([]);
    vi.useRealTimers();
  });

  it("without audio (no voice) the OBS page shows the caption and still reports start and end", () => {
    vi.useFakeTimers();
    const { p, sent, audios } = setup();
    p.handle({ type: "SPEECH", clip: { ...clip("w1", "welcome"), url: null } });
    expect(p.view().clip?.id).toBe("w1");
    expect(sent).toEqual([{ type: "SPEECH_STARTED", id: "w1" }]);
    vi.advanceTimersByTime(10_000);
    expect(p.view().clip).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "SPEECH_ENDED", id: "w1" });
    expect(audios).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe("SpeechPlayer — the computer's own voice when there is no Vbee audio", () => {
  class FakeSynth {
    spoken: UtteranceLike[] = [];
    paused = false;
    constructor(public voices: VoiceLike[]) {}
    speak(u: UtteranceLike) {
      this.spoken.push(u);
    }
    cancel() {}
    pause() {
      this.paused = true;
    }
    resume() {
      this.paused = false;
    }
    getVoices() {
      return this.voices;
    }
  }
  const mkU = (text: string): UtteranceLike => ({ text, voice: null, lang: "", rate: 1, onstart: null, onend: null, onerror: null });
  const noAudio = (id: string): SpeechClip => ({ id, kind: "welcome", label: "Trợ lý AI", text: "Chào Lan ạ", url: null, caption_only: true, fallback: { name: null, rate: 1.1, lang: "vi-VN" } });
  const AN: VoiceLike = { name: "Microsoft An - Vietnamese (Vietnam)", lang: "vi-VN", localService: true };
  const DAVID: VoiceLike = { name: "Microsoft David", lang: "en-US", localService: true };

  it("picks a Vietnamese voice, the named one first", () => {
    const hoai: VoiceLike = { name: "Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)", lang: "vi-VN", localService: false };
    expect(pickVoice([DAVID, AN], null)?.name).toBe(AN.name);
    expect(pickVoice([DAVID, AN, hoai], null)?.name).toBe(hoai.name);
    expect(pickVoice([DAVID, AN, hoai], AN.name)?.name).toBe(AN.name);
    expect(pickVoice([DAVID], null)).toBeNull();
  });

  it("reads the line aloud and reports start/end", () => {
    const synth = new FakeSynth([DAVID, AN]);
    const sent: ClientGameMessage[] = [];
    const p = new SpeechPlayer({ audible: true, emit: (m) => sent.push(m), onChange: () => undefined, synth, makeUtterance: mkU });
    p.handle({ type: "SPEECH", clip: noAudio("s1") });
    expect(synth.spoken).toHaveLength(1);
    const u = synth.spoken[0];
    expect(u.voice?.name).toBe(AN.name);
    expect(u.rate).toBe(1.1);
    expect(sent).toEqual([]);
    u.onstart!();
    expect(sent).toEqual([{ type: "SPEECH_STARTED", id: "s1" }]);
    p.hold(true);
    expect(synth.paused).toBe(true);
    p.hold(false);
    expect(synth.paused).toBe(false);
    u.onend!();
    expect(sent.at(-1)).toEqual({ type: "SPEECH_ENDED", id: "s1" });
  });

  it("no Vietnamese voice on this computer: caption only; blocked tab asks for a click", () => {
    vi.useFakeTimers();
    const synth = new FakeSynth([DAVID]);
    const sent: ClientGameMessage[] = [];
    const p = new SpeechPlayer({ audible: true, emit: (m) => sent.push(m), onChange: () => undefined, synth, makeUtterance: mkU });
    p.handle({ type: "SPEECH", clip: noAudio("s1") });
    expect(synth.spoken).toHaveLength(0);
    expect(sent).toEqual([{ type: "SPEECH_STARTED", id: "s1" }]);
    vi.advanceTimersByTime(5000);
    expect(sent.at(-1)).toEqual({ type: "SPEECH_ENDED", id: "s1" });

    synth.voices = [AN];
    p.handle({ type: "SPEECH", clip: noAudio("s2") });
    synth.spoken[0].onerror!({ error: "not-allowed" });
    expect(p.view().blocked).toBe(true);
    p.unlock();
    expect(synth.spoken).toHaveLength(2);
    vi.useRealTimers();
  });
});
