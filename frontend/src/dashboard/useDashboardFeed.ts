import { useEffect, useRef, useState } from "react";
import { SequencedSocket, wsUrl } from "../lib/ws";

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
}

type Msg =
  | { type: "COMMENT"; sequence: number; comment: CommentRecord }
  | { type: "HOST_ATTENTION"; sequence: number; item: HostItem }
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
      },
      onMessage: (m) => {
        if (m.type === "COMMENT") setComments((c) => [m.comment, ...c].slice(0, 200));
        else if (m.type === "HOST_ATTENTION") setHost((h) => [m.item, ...h].slice(0, 100));
        else if (m.type === "LIVE_STATUS") setLive(m.status);
        else if (m.type === "METRICS") setMetrics(m.metrics);
        else if (m.type === "AI_PAUSED") setAiPaused(m.paused);
      },
      onStatus: setConnected,
    });
    sockRef.current = sock;
    sock.start();
    return () => sock.stop();
  }, [enabled]);

  return { comments, host, live, metrics, aiPaused, setAiPaused, connected };
}
