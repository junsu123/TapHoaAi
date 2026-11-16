// Host view: who has stayed longest this LIVE (Chibi levels), and the latest level-ups.

import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";

interface LevelsView {
  enabled: boolean;
  minutes: number[];
  items: string[];
  watching: number;
  top: { name: string; minutes: number; level: number; counting: boolean }[];
  recent: { name: string; level: number; item: string; minutes: number; at: number }[];
}

export function LevelsCard() {
  const [v, setV] = useState<LevelsView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const tryIt = async () => {
    setMsg(null);
    try {
      const r = await api.post<{ message: string }>("/levels/try", {});
      setMsg(r.message);
    } catch (x) {
      setMsg(x instanceof ApiError ? x.message : String(x));
    }
  };
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<LevelsView>("/levels")
        .then((r) => alive && setV(r))
        .catch(() => undefined);
    load();
    const id = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!v) return <p className="muted">Đang tải…</p>;
  if (!v.enabled) return <p className="muted">Đang tắt — bật ở Game 3D & OBS → Không gian cửa hàng → Chibi lên cấp.</p>;
  return (
    <div data-testid="levels-card">
      <p className="muted small">
        Đang tính giờ cho {v.watching} người xem · cấp 1 sau {v.minutes[0]} phút ({v.items[0]}), cấp 2 sau {v.minutes[1]} phút ({v.items[1]}), cấp 3 sau{" "}
        {v.minutes[2]} phút ({v.items[2]}).
      </p>
      {v.top.length === 0 ? (
        <p className="muted">Chưa có ai — khi LIVE bắt đầu, người xem sẽ hiện ở đây.</p>
      ) : (
        <ol className="levels-top">
          {v.top.map((w, i) => (
            <li key={`${w.name}-${i}`}>
              <span className={`lv-badge lv${w.level}`}>{w.level}</span>
              <span className="lv-name">{w.name}</span>
              <span className="muted">
                {Math.floor(w.minutes)} phút{w.counting ? "" : " · đã ngừng tính"}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="row">
        <button type="button" className="btn" onClick={tryIt}>
          Thử (Demo): cho một Chibi lên cấp ngay
        </button>
        {msg && (
          <span className="muted small" data-testid="levels-try-msg">
            {msg}
          </span>
        )}
      </div>
      {v.recent.length > 0 && (
        <p className="muted small">
          Vừa lên cấp: {v.recent.slice(0, 4).map((r) => `${r.name} (${r.item})`).join(", ")}
        </p>
      )}
    </div>
  );
}
