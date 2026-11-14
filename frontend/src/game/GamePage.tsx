// /game/live — full-screen 9:16 game for OBS (no admin navigation, no debug banners).
// URL options: ?role=viewer (preview, never ACKs) · ?quality=low|medium|high · ?token=…
// · ?safeTop=0.1&safeBottom=0.2&safeRight=0.15 · ?debug=1 (exposes window.__chibiDebug).

import { useEffect, useMemo, useRef, useState } from "react";
import { SequencedSocket, wsUrl } from "../lib/ws";
import type { ClientGameMessage, GameSnapshot, ServerGameMessage } from "../types/protocol";
import { GameEngine } from "./GameEngine";
import { LiveOverlay, type SafeArea } from "./LiveOverlay";
import { pickVoice, SpeechPlayer, vietnameseVoices, type SpeechView, type VoiceLike } from "./SpeechPlayer";
import { World, type Quality } from "./World";

const ORDER: Quality[] = ["low", "medium", "high"];

export function GamePage() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const role = params.get("role") === "viewer" ? "viewer" : "primary";
  const debug = params.get("debug") === "1";
  const [quality, setQuality] = useState<Quality>((ORDER as string[]).includes(params.get("quality") ?? "") ? (params.get("quality") as Quality) : "medium");
  const autoQuality = params.get("quality") === null;
  const safe: SafeArea = {
    top: Number(params.get("safeTop") ?? 0.1),
    bottom: Number(params.get("safeBottom") ?? 0.2),
    right: Number(params.get("safeRight") ?? 0.15),
    left: Number(params.get("safeLeft") ?? 0.04),
  };
  const [socketUp, setSocketUp] = useState(false);
  const socketRef = useRef<SequencedSocket<GameSnapshot, ServerGameMessage> | null>(null);
  const engine = useMemo(
    () => new GameEngine((m: ClientGameMessage) => (role === "primary" ? socketRef.current?.send(m) : undefined)),
    [role],
  );
  const [speech, setSpeech] = useState<SpeechView>({ clip: null, held: false, blocked: false });
  const player = useMemo(
    () =>
      new SpeechPlayer({
        audible: role === "primary" && params.get("mute") !== "1",
        emit: (m) => socketRef.current?.send(m),
        onChange: setSpeech,
      }),
    [role, params],
  );
  const fpsLog = useRef<number[]>([]);
  const lowSince = useRef<number | null>(null);

  useEffect(() => {
    const token = params.get("token");
    const url = wsUrl(`/ws/game?role=${role}${token ? `&token=${encodeURIComponent(token)}` : ""}`);
    const sock = new SequencedSocket<GameSnapshot, ServerGameMessage>(url, {
      onSnapshot: (s) => engine.applySnapshot(s),
      onMessage: (m) => {
        if (m.type === "SPEECH" || m.type === "SPEECH_STOP" || m.type === "SPEECH_HOLD") player.handle(m);
        else engine.handle(m);
      },
      onStatus: setSocketUp,
    });
    socketRef.current = sock;
    sock.start();
    if (debug) {
      (window as unknown as Record<string, unknown>).__chibiDebug = {
        state: () => engine.debugState(),
        fps: () => [...fpsLog.current],
        camera: () => (window as unknown as { __chibiCamera?: object }).__chibiCamera,
        speech: () => player.view(),
      };
    }
    return () => {
      sock.stop();
      player.stop();
    };
  }, [engine, player, role, debug, params]);

  // tell the server which Vietnamese voices this computer has and whether the browser blocks sound,
  // so the host page can say exactly why greetings are (not) heard
  useEffect(() => {
    if (role !== "primary" || !socketUp) return;
    const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
    const report = () => {
      const all = (synth?.getVoices() ?? []) as unknown as VoiceLike[];
      const vi = vietnameseVoices(all);
      socketRef.current?.send({
        type: "PLAYER_INFO",
        speech_api: !!synth,
        voice_count: all.length,
        voices: vi.map((v) => ({ name: v.name, lang: v.lang, local: v.localService })),
        fallback_voice: pickVoice(all, null)?.name ?? null,
        blocked: speech.blocked,
        user_agent: navigator.userAgent,
      });
    };
    report();
    synth?.addEventListener?.("voiceschanged", report);
    const late = setTimeout(report, 1500); // voices often load a moment after the page
    return () => {
      clearTimeout(late);
      synth?.removeEventListener?.("voiceschanged", report);
    };
  }, [role, socketUp, speech.blocked]);

  // FPS telemetry + automatic quality step-down (NFR-02)
  const onFps = (fps: number) => {
    fpsLog.current.push(+fps.toFixed(1));
    if (fpsLog.current.length > 300) fpsLog.current.shift();
    if (fpsLog.current.length % 5 === 0 && role === "primary") {
      socketRef.current?.send({ type: "FPS_REPORT", fps: +fps.toFixed(1), quality, avatars: engine.avatars.size });
    }
    if (!autoQuality) return;
    if (fps < 24) {
      lowSince.current ??= performance.now();
      if (performance.now() - lowSince.current > 5000 && quality !== "low") {
        setQuality(ORDER[ORDER.indexOf(quality) - 1]);
        lowSince.current = null;
      }
    } else lowSince.current = null;
  };

  return (
    <div className="game-root">
      <div className="game-stage" data-testid="game-stage">
        <World engine={engine} quality={quality} onFps={onFps} />
        <LiveOverlay engine={engine} safe={safe} socketUp={socketUp} speech={speech} onUnlockAudio={() => player.unlock()} />
      </div>
    </div>
  );
}
