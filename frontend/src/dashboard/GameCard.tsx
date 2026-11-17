// Host view of the mini-games: the round on now, start one by hand, the next one, recent winners.

import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { GameView } from "../types/protocol";

interface GamesView {
  enabled: boolean;
  round: GameView | null;
  next_in_s: number | null;
  kinds: string[];
  has_prices: boolean;
  history: { id: string; kind: string; title: string; answers: number; winners: string[]; at: number }[];
}

const KINDS: { kind: "price" | "quiz" | "keyword"; label: string }[] = [
  { kind: "price", label: "Đoán giá" },
  { kind: "quiz", label: "Đố vui" },
  { kind: "keyword", label: "Nhanh tay" },
];

export function GameCard() {
  const [v, setV] = useState<GamesView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () =>
    api
      .get<GamesView>("/games")
      .then(setV)
      .catch(() => undefined);
  useEffect(() => {
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);
  const call = async (path: string, body: object = {}) => {
    setMsg(null);
    try {
      await api.post(path, body);
      await load();
    } catch (x) {
      setMsg(x instanceof ApiError ? x.message : String(x));
    }
  };
  if (!v) return <p className="muted">Đang tải…</p>;
  const r = v.round;
  return (
    <div data-testid="game-card">
      {r ? (
        <p data-testid="game-card-round">
          🎮 Đang chơi <b>{r.title}</b> —{" "}
          {r.phase === "intro" ? "sắp bắt đầu" : r.phase === "open" ? `còn ${Math.max(0, Math.ceil((r.closes_at - Date.now()) / 1000))} giây` : "đang công bố kết quả"} ·{" "}
          {r.answers} bạn đã trả lời
          {r.winners && r.winners.length > 0 && <> · thắng: {r.winners.join(", ")}</>}
        </p>
      ) : (
        <p className="muted">
          {!v.enabled
            ? "Mini-game tự động đang tắt (bật ở Không gian cửa hàng → Mini-game). Vẫn bắt đầu bằng tay được."
            : v.next_in_s != null
              ? `Mini-game tiếp theo sau khoảng ${Math.ceil(v.next_in_s / 60)} phút.`
              : "Mini-game tự động bắt đầu đếm giờ khi đang LIVE (hoặc Demo)."}
        </p>
      )}
      <div className="row wrap">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className="btn"
            disabled={!!r || (k.kind === "price" && !v.has_prices)}
            title={k.kind === "price" && !v.has_prices ? "Chưa có sản phẩm có giá đã kiểm tra" : undefined}
            onClick={() => call("/games/start", { kind: k.kind })}
          >
            Bắt đầu: {k.label}
          </button>
        ))}
        {r && (
          <button type="button" className="btn" onClick={() => call("/games/stop")}>
            Dừng mini-game
          </button>
        )}
      </div>
      {msg && <p className="error">{msg}</p>}
      {v.history.length > 0 && (
        <ul className="game-history">
          {v.history.map((h) => (
            <li key={h.id}>
              <b>{h.title}</b> · {h.answers} bạn chơi · {h.winners.length ? `thắng: ${h.winners.join(", ")}` : "chưa ai thắng"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
