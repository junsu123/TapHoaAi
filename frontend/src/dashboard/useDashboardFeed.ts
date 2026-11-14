import { useEffect, useRef, useState } from "react";
import type { VoiceTraceEntry } from "./VoiceCheck";
import { SequencedSocket, wsUrl } from "../lib/ws";
import type { AiStatus } from "./AiSettingsPage";
import type { LogRecord, LogStats } from "./LogsPage";

export interface CommentRecord {
  event_id: string;
  at: string;
  nickname: string | null;
  unique_id: string | null;
  text: string;
  intent: string;
  product_id: string | null;
  product_name: string | null;
  confidence: number;
  candidates: { product_id: string; name: string; score: number }[];
  action_outcome: string | null;
  is_demo: boolean;
}

export interface HostItem extends CommentRecord {
  status: string;
  hint: string;
  suggestion: string | null;
  suggestion_label?: string | null;
  review_reasons?: string[];
  question_read?: boolean;
  spoken?: boolean;
  duplicate_of?: string;
}

export interface SpeechClipSummary {
  id: string;
  kind: string;
  label: string;
  text: string;
  status: string;
  error: string | null;
  ref: string | null;
}

export interface SpeechState {
  muted: boolean;
  hold: boolean;
  player: boolean;
  player_info?: { speech_api?: boolean; voices?: { name: string; lang: string; local: boolean }[]; fallback_voice?: string | null; blocked?: boolean };
  current: SpeechClipSummary | null;
  queue: SpeechClipSummary[];
  history: SpeechClipSummary[];
}

export interface Alert {
  code: string;
  message: string;
  at: number;
}

export interface LiveStatus {
  session_id: string | null;
  status: string;
  detail: string | null;
  provider: string | null;
  url: string | null;
  unique_id: string | null;
  room_id: string | null;
  is_demo: boolean;
  capabilities: Record<string, string>;
  reconnect_log: { at: string; error: string; attempt: number; retry_in_s: number | null }[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Metrics = Record<string, any>;

interface Snap {
  type: "SNAPSHOT";
  sequence: number;
  live: LiveStatus;
  comments: CommentRecord[];
  host_attention: HostItem[];
  ai_paused: boolean;
  speech?: SpeechState;
  ai?: AiStatus;
  logs?: LogStats;
  voice_trace?: VoiceTraceEntry[];
}

type Msg =
  | { type: "COMMENT"; sequence: number; comment: CommentRecord }
  | { type: "HOST_ATTENTION"; sequence: number; item: HostItem }
  | { type: "HOST_ATTENTION_UPDATE"; sequence: number; item: HostItem }
  | { type: "SPEECH_STATE"; sequence: number; speech: SpeechState }
  | { type: "AI_STATUS"; sequence: number; ai: AiStatus }
  | { type: "VOICE_TRACE"; sequence: number; entry: VoiceTraceEntry }
  | { type: "ALERT"; sequence: number; code: string; message: string }
  | { type: "LOG"; sequence: number; record: LogRecord; new: boolean }
  | { type: "LOG_STATS"; sequence: number; stats: LogStats }
  | { type: "LIVE_STATUS"; sequence: number; status: LiveStatus }
  | { type: "METRICS"; sequence: number; metrics: Metrics }
  | { type: "AI_PAUSED"; sequence: number; paused: boolean }
  | { type: "ACTION_UPDATE"; sequence: number }
  | { type: "PONG"; sequence?: number };

export function useDashboardFeed(enabled: boolean) {
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [host, setHost] = useState<HostItem[]>([]);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [aiPaused, setAiPaused] = useState(false);
  const [speech, setSpeech] = useState<SpeechState | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [logStats, setLogStats] = useState<LogStats | null>(null);
  const [liveLogs, setLiveLogs] = useState<LogRecord[]>([]);
  const [voiceTrace, setVoiceTrace] = useState<VoiceTraceEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const sockRef = useRef<SequencedSocket<Snap, Msg> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const sock = new SequencedSocket<Snap, Msg>(wsUrl("/ws/dashboard"), {
      onSnapshot: (s) => {
        setComments(s.comments.slice().reverse());
        setHost(s.host_attention.slice().reverse());
        setLive(s.live);
        setAiPaused(s.ai_paused);
        if (s.speech) setSpeech(s.speech);
        if (s.ai) setAi(s.ai);
        if (s.logs) setLogStats(s.logs);
        if (s.voice_trace) setVoiceTrace(s.voice_trace.slice().reverse());
      },
      onMessage: (m) => {
        if (m.type === "COMMENT") setComments((c) => [m.comment, ...c].slice(0, 200));
        else if (m.type === "HOST_ATTENTION") setHost((h) => [m.item, ...h.filter((x) => x.event_id !== m.item.event_id)].slice(0, 100));
        else if (m.type === "HOST_ATTENTION_UPDATE") setHost((h) => (h.some((x) => x.event_id === m.item.event_id) ? h.map((x) => (x.event_id === m.item.event_id ? m.item : x)) : [m.item, ...h]));
        else if (m.type === "SPEECH_STATE") setSpeech(m.speech);
        else if (m.type === "AI_STATUS") setAi(m.ai);
        else if (m.type === "VOICE_TRACE") setVoiceTrace((t) => [m.entry, ...t].slice(0, 60));
        else if (m.type === "LOG") {
          setLiveLogs((l) => [m.record, ...l.filter((x) => x.id !== m.record.id)].slice(0, 200));
          if (m.new && m.record.level !== "INFO")
            setLogStats((st) => (st ? { ...st, unseen: st.unseen + 1, last_id: Math.max(st.last_id, m.record.id) } : st));
        } else if (m.type === "LOG_STATS") setLogStats(m.stats);
        else if (m.type === "ALERT") setAlerts((a) => [{ code: m.code, message: m.message, at: Date.now() }, ...a].slice(0, 5));
        else if (m.type === "LIVE_STATUS") setLive(m.status);
        else if (m.type === "METRICS") {
          setMetrics(m.metrics);
          if (m.metrics.ai) setAi(m.metrics.ai as AiStatus);
        }
        else if (m.type === "AI_PAUSED") setAiPaused(m.paused);
      },
      onStatus: setConnected,
    });
    sockRef.current = sock;
    sock.start();
    return () => sock.stop();
  }, [enabled]);

  return { comments, host, live, metrics, aiPaused, setAiPaused, connected, speech, ai, alerts, logStats, setLogStats, liveLogs, voiceTrace };
}
