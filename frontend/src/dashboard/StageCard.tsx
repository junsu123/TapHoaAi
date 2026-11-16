// Host view of the dance stage: who is on it, who is next; skip / remove / clear.

import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { StageView } from "../types/protocol";

export function StageCard({ stage }: { stage: StageView | null }) {
  const [err, setErr] = useState<string | null>(null);
  const call = async (path: string, body: object = {}) => {
    setErr(null);
    try {
      await api.post(`/stage/${path}`, body);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  };
  if (!stage) return <p className="muted">Đang tải…</p>;
  if (!stage.enabled) return <p className="muted">Sân khấu đang tắt — bật ở Không gian & banner → Sân khấu.</p>;
  const cur = stage.current;
  return (
    <div className="stage-card" data-testid="stage-card">
      <div className="row wrap">
        {cur ? (
          <span data-testid="stage-card-current">
            {cur.phase === "dancing" ? "🎤 Đang nhảy: " : "📣 Đang mời: "}
            <b>{cur.name}</b>
            {cur.seconds_left != null && <span className="muted"> · còn {cur.seconds_left} giây</span>}
          </span>
        ) : (
          <span className="muted">Chưa có ai trên sân khấu.</span>
        )}
        {cur && (
          <button type="button" className="btn" onClick={() => call("skip")}>
            Cho xuống / bỏ lượt
          </button>
        )}
      </div>
      <p className="muted">
        Đang chờ {stage.waiting} người · đã nhảy {stage.performed} · bỏ lượt {stage.skipped}
      </p>
      {stage.queue.length > 0 && (
        <ol className="stage-queue" data-testid="stage-queue">
          {stage.queue.map((q, i) => (
            <li key={q.key ?? `${q.name}-${i}`}>
              <span>{q.name}</span>
              {q.key && (
                <button type="button" className="link" onClick={() => call("remove", { key: q.key })} aria-label={`Bỏ ${q.name} khỏi hàng chờ`}>
                  Bỏ
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {stage.queue.length > 0 && (
        <button type="button" className="btn" onClick={() => call("clear")}>
          Xóa hàng chờ
        </button>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
