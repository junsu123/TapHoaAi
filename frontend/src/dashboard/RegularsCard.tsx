// Host view: khách quen — who came back this LIVE, how many LIVEs in a row.

import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface RegularsView {
  seq: number;
  kind: "live" | "demo";
  new: number;
  returning: number;
  continued: number;
  regulars_here: number;
  top: { name: string; visits: number; streak: number; minutes: number }[];
  recent_back: { name: string; visits: number; streak: number; at: number }[];
}

export function RegularsCard() {
  const [v, setV] = useState<RegularsView | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<RegularsView>("/regulars")
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
  return (
    <div data-testid="regulars-card">
      <p className="muted small">
        {v.kind === "demo" ? "Demo" : "LIVE"} số {v.seq}: {v.returning} khách quay lại · {v.new} khách mới · {v.regulars_here} khách quen (đến từ 3 buổi trở
        lên) đang xem.
      </p>
      {v.top.length === 0 ? (
        <p className="muted">Chưa có ai quay lại trong buổi này — khách đã xem các buổi trước sẽ hiện ở đây, và chủ quán chào họ bằng tên.</p>
      ) : (
        <ol className="levels-top">
          {v.top.map((p, i) => (
            <li key={`${p.name}-${i}`}>
              <span className="lv-name">
                {p.visits >= 3 && <span aria-label="khách quen">❤ </span>}
                {p.name}
              </span>
              <span className="muted">
                {p.visits} buổi{p.streak >= 2 ? ` · ${p.streak} buổi liên tiếp` : ""} · {p.minutes} phút
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
