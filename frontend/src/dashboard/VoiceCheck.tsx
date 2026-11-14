// "Why is nobody greeted / no comment read?" — the live checklist and what happened to each
// join and comment, newest first.

import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { AiStatus } from "./AiSettingsPage";

export interface VoiceCheckItem {
  id: string;
  ok: boolean;
  label: string;
  fix: string;
  detail?: string;
}

export interface VoiceTraceEntry {
  at: number;
  kind: "join" | "welcome" | "comment" | "question";
  who: string;
  text: string;
  ok: boolean;
  reason: string;
}

const KIND: Record<VoiceTraceEntry["kind"], string> = {
  join: "👋 Vào LIVE",
  welcome: "🔊 Lời chào",
  comment: "💬 Bình luận",
  question: "❓ Câu hỏi",
};

const HOW: Record<string, string> = {
  vbee: "Đã gửi câu thử tới trang LIVE — đọc bằng giọng Vbee.",
  browser: "Đã gửi câu thử tới trang LIVE — đọc bằng giọng có sẵn của máy phát LIVE (nếu máy có giọng tiếng Việt).",
  caption: "Đã gửi câu thử tới trang LIVE — chỉ hiện phụ đề (không có giọng đọc).",
};

export function VoiceCheck({ ai, trace }: { ai: AiStatus | null; trace: VoiceTraceEntry[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checks = ai?.checks ?? [];
  const bad = checks.filter((c) => !c.ok);
  return (
    <div className="voice-check" data-testid="voice-check">
      <p className={bad.length ? "vc-summary bad" : "vc-summary ok"} data-testid="voice-check-summary">
        {checks.length === 0
          ? "Đang kiểm tra…"
          : bad.length
            ? `⚠ ${bad.length} điều cần sửa để trợ lý chào người vào và đọc bình luận:`
            : "✅ Mọi thứ sẵn sàng — người vào LIVE được chào, bình luận được đọc."}
      </p>
      <ul className="vc-list">
        {checks.map((c) => (
          <li key={c.id} className={c.ok ? "ok" : "bad"} data-testid={`check-${c.id}`} data-ok={c.ok ? "1" : "0"}>
            <span className="vc-icon">{c.ok ? "✅" : "❌"}</span>
            <span>
              <b>{c.label}</b>
              {c.detail && <span className="vc-detail"> — {c.detail}</span>}
              {!c.ok && c.fix && <span className="vc-fix">Cách sửa: {c.fix}</span>}
            </span>
          </li>
        ))}
      </ul>
      <div className="row wrap">
        <button
          disabled={busy}
          onClick={async () => {
            setMsg(null);
            setBusy(true);
            try {
              const r = await api.post<{ how: string }>("/voice/test-live");
              setMsg(HOW[r.how] ?? "Đã gửi câu thử.");
            } catch (x) {
              setMsg(x instanceof ApiError ? x.message : String(x));
            } finally {
              setBusy(false);
            }
          }}
          data-testid="voice-test-live"
        >
          📣 Đọc thử một câu trên trang LIVE
        </button>
        {msg && (
          <span className="muted" data-testid="voice-test-live-msg">
            {msg}
          </span>
        )}
      </div>
      <h3 className="vc-h">Người vào & bình luận gần đây — đã đọc hay chưa, vì sao</h3>
      {trace.length === 0 && <p className="muted small">Chưa có ai vào hoặc bình luận từ khi mở trang này.</p>}
      <ul className="vc-trace" data-testid="voice-trace">
        {trace.slice(0, 25).map((t, i) => (
          <li key={`${t.at}-${i}`} className={t.ok ? "ok" : "bad"}>
            <span className="vc-time">{new Date(t.at * 1000).toLocaleTimeString("vi-VN")}</span>
            <span className="vc-kind">{KIND[t.kind] ?? t.kind}</span>
            <span className="vc-who">{t.who || "—"}</span>
            {t.text && <span className="vc-text">“{t.text}”</span>}
            <span className="vc-reason">
              {t.ok ? "✔" : "✖"} {t.reason}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
