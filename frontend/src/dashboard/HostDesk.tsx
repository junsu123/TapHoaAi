// Host desk: questions with Claude's drafts (Đọc / Sửa rồi đọc / Bỏ qua) and the voice controls —
// kill switch (F9), "Tôi đang nói" (hold Space) and an optional mic-level auto hold.

import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { usd, type AiStatus } from "./AiSettingsPage";
import type { HostItem, SpeechState } from "./useDashboardFeed";

const STATUS_CLASS: Record<string, string> = {
  "AI đề xuất": "chip-ai",
  "Cần người trực xem": "chip-warn",
  "Người trực đã xác nhận": "chip-ok",
  "Đã đọc tự động": "chip-ok",
  "Đã trả lời tự động": "chip-ok",
  "AI đang soạn…": "chip-ai",
  "Đã bỏ qua": "chip-muted",
  "Trùng câu hỏi": "chip-muted",
};

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** Microphone level → hold the AI voice while the host is talking (opt-in, needs mic permission). */
function useMicHold(enabled: boolean, threshold: number, onHold: (h: boolean) => void) {
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const holdRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let raf = 0;
    let loudSince = 0;
    let quietSince = 0;
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (stop) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        const loop = () => {
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          const lvl = Math.min(1, rms * 8);
          setLevel(lvl);
          const now = performance.now();
          if (lvl > threshold) {
            quietSince = 0;
            loudSince ||= now;
            if (!holdRef.current && now - loudSince > 150) {
              holdRef.current = true;
              onHold(true);
            }
          } else {
            loudSince = 0;
            quietSince ||= now;
            if (holdRef.current && now - quietSince > 900) {
              holdRef.current = false;
              onHold(false);
            }
          }
          raf = requestAnimationFrame(loop);
        };
        loop();
      })
      .catch(() => setErr("Không mở được micro (trình duyệt chưa cho phép)."));
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close();
      if (holdRef.current) {
        holdRef.current = false;
        onHold(false);
      }
      setLevel(0);
    };
  }, [enabled, threshold, onHold]);
  return { level, err };
}

export function VoiceBar({ speech, ai }: { speech: SpeechState | null; ai: AiStatus | null }) {
  const [err, setErr] = useState<string | null>(null);
  const [micAuto, setMicAuto] = useState(false);
  const [threshold, setThreshold] = useState(0.18);
  const call = useCallback(async (path: string, body?: object) => {
    setErr(null);
    try {
      await api.post(path, body);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  }, []);
  const setHold = useCallback((h: boolean) => call("/voice/hold", { hold: h }), [call]);
  const mic = useMicHold(micAuto, threshold, setHold);

  useEffect(() => {
    let spaceDown = false;
    const down = (e: KeyboardEvent) => {
      if (e.key === "F9") {
        e.preventDefault();
        call("/voice/kill");
      } else if (e.code === "Space" && !isTyping(e) && !e.repeat && !spaceDown) {
        e.preventDefault();
        spaceDown = true;
        setHold(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && spaceDown) {
        spaceDown = false;
        setHold(false);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [call, setHold]);

  const playing = speech?.current;
  const auto = !!ai?.autopilot;
  return (
    <div className="voice-bar" data-testid="voice-bar">
      <button className={`autopilot-toggle${auto ? " on" : ""}`} onClick={() => call("/ai/autopilot", { on: !auto })} data-testid="autopilot-toggle" aria-pressed={auto}>
        <span className="ap-icon">🤖</span>
        <span>
          <b>Tự động hoàn toàn: {auto ? "BẬT" : "TẮT"}</b>
          {ai && (
            <span className="small">
              {ai.greet_joins ? "👋 chào người vào" : ""}
              {ai.greet_joins && ai.read_comments ? " · " : ""}
              {ai.read_comments ? "💬 đọc bình luận" : ""}
              {ai.greet_joins || ai.read_comments ? " — luôn bật khi phát trên LIVE" : ""}
            </span>
          )}
          <span className="small">{auto ? "Đang tự đọc bình luận và trả lời — bấm để tắt" : "Bấm để tự đọc bình luận và trả lời, không chờ người trực"}</span>
        </span>
      </button>
      <div className="row wrap">
        {speech?.muted ? (
          <button className="primary" onClick={() => call("/voice/unmute")} data-testid="voice-unmute">
            🔊 Bật lại giọng
          </button>
        ) : (
          <button className="danger" onClick={() => call("/voice/kill")} data-testid="voice-kill">
            ⏹ Tắt giọng ngay (F9)
          </button>
        )}
        <button
          className={speech?.hold ? "primary" : ""}
          onPointerDown={() => setHold(true)}
          onPointerUp={() => setHold(false)}
          onPointerLeave={() => speech?.hold && setHold(false)}
          data-testid="voice-hold"
        >
          🎙 {speech?.hold ? "Đang giữ — AI im" : "Giữ để nói (Space)"}
        </button>
        <label className="check">
          <input type="checkbox" checked={micAuto} onChange={(e) => setMicAuto(e.target.checked)} aria-label="Tự im khi micro có tiếng" />
          Tự im khi micro có tiếng
        </label>
        {micAuto && (
          <span className="mic-meter" title="Mức micro — vạch đỏ là ngưỡng">
            <span className="mic-level" style={{ width: `${Math.round(mic.level * 100)}%` }} />
            <input type="range" min={0.05} max={0.6} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} aria-label="Ngưỡng micro" />
          </span>
        )}
      </div>
      <div className="row wrap small">
        {ai && (
          <>
            <span className={`chip ${ai.voice_ready ? "chip-ok" : "chip-warn"}`}>{ai.voice_ready ? `Giọng đọc bật · ${ai.autopilot ? "tự động hoàn toàn" : ai.answer_mode === "auto" ? "tự động đọc câu an toàn" : "người trực duyệt"}` : ai.voice_reason}</span>
            <span className="chip">
              AI hôm nay {usd(ai.budget.day_usd)} / {ai.budget.day_cap} USD
            </span>
          </>
        )}
        {speech && !speech.player && <span className="chip chip-warn">Chưa mở trang game (OBS) — chưa phát được tiếng</span>}
        {ai?.voice_ready && ai.audio_note && (
          <span className="chip chip-warn" data-testid="caption-only-note">
            {ai.audio_note}
          </span>
        )}
        {playing && (
          <span className="chip chip-ai" data-testid="voice-playing">
            ▶ {playing.label}: {playing.text.slice(0, 60)}
            {playing.text.length > 60 ? "…" : ""} ({playing.status})
          </span>
        )}
        {speech && speech.queue.length > 0 && <span className="chip">Chờ phát: {speech.queue.length}</span>}
        <NavLink to="/dashboard/ai" className="small">
          Cài đặt AI & giọng đọc →
        </NavLink>
      </div>
      {(err || mic.err) && <p className="error small">{err || mic.err}</p>}
    </div>
  );
}

export function QuestionCard({ h }: { h: HostItem }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(h.suggestion ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setText(h.suggestion ?? "");
  }, [h.suggestion, editing]);
  const done = ["Người trực đã xác nhận", "Đã đọc tự động", "Đã trả lời tự động", "Đã bỏ qua"].includes(h.status);
  const speak = async (body: { text?: string }) => {
    setErr(null);
    try {
      const r = await api.post<{ spoken: boolean; reason: string | null }>(`/ai/suggestions/${encodeURIComponent(h.event_id)}/speak`, body);
      setNote(r.spoken ? "Đã đưa vào hàng đọc." : `Đã xác nhận nhưng không phát giọng: ${r.reason}`);
      setEditing(false);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  };
  return (
    <li className={`host-item${done ? " done" : ""}`} data-testid="host-item" data-status={h.status}>
      <div>
        <span className={`chip ${STATUS_CLASS[h.status] ?? "chip-warn"}`}>{h.status}</span> <b>{h.nickname}</b>: {h.text}
        {h.question_read && <span className="muted small"> · 🔊 đã đọc câu hỏi</span>}
      </div>
      {h.hint && <div className="muted small">{h.hint}</div>}
      {h.candidates.length > 0 && <div className="muted small">Có thể là: {h.candidates.map((c) => c.name).join(", ")}</div>}
      {h.suggestion && !editing && (
        <div className="suggestion" data-testid="suggestion">
          <span className="muted small">{h.suggestion_label ?? "Gợi ý"}:</span> “{h.suggestion}”
        </div>
      )}
      {h.review_reasons && h.review_reasons.length > 0 && <div className="warn-text small">⚠ {h.review_reasons.join(" · ")}</div>}
      {editing && (
        <textarea rows={2} maxLength={280} value={text} onChange={(e) => setText(e.target.value)} aria-label="Sửa câu trả lời" autoFocus />
      )}
      {h.status !== "Trùng câu hỏi" && (
        <div className="row wrap">
          {editing ? (
            <>
              <button className="primary" onClick={() => speak({ text })} disabled={!text.trim()}>
                🔊 Đọc câu đã sửa
              </button>
              <button onClick={() => setEditing(false)}>Hủy</button>
            </>
          ) : (
            <>
              {h.suggestion && (
                <button className="primary" onClick={() => speak({})} data-testid="speak">
                  🔊 Đọc
                </button>
              )}
              <button onClick={() => setEditing(true)}>{h.suggestion ? "✏️ Sửa rồi đọc" : "✏️ Viết câu trả lời"}</button>
              {!done && (
                <button
                  onClick={() =>
                    api.post(`/ai/suggestions/${encodeURIComponent(h.event_id)}/dismiss`).catch((x) => setErr(String(x)))
                  }
                >
                  Bỏ qua
                </button>
              )}
            </>
          )}
        </div>
      )}
      {note && <div className="muted small">{note}</div>}
      {err && <div className="error small">{err}</div>}
    </li>
  );
}
