// Game page performance (spec V3 §10, T16): live numbers from the OBS page, and a benchmark
// that fills the demo shop with 30 or 50 Chibis and measures for 20 seconds on this very PC.

import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";

interface Report {
  fps: number | null;
  frame_ms_p95: number | null;
  sim_ms: number | null;
  render_calls: number | null;
  triangles: number | null;
  heap_mb: number | null;
  gpu: string | null;
  quality: string;
  avatars: number;
  lod: { full: number; reduced: number; far: number; hidden: number };
  window_px?: [number, number] | null;
  render_px?: [number, number] | null;
}
interface Result {
  target: number;
  avatars: number;
  samples: number;
  fps_avg: number | null;
  fps_min: number | null;
  frame_ms_p95: number | null;
  sim_ms: number | null;
  render_calls: number | null;
  heap_mb: number | null;
  gpu: string | null;
  quality: string | null;
  done: boolean;
}
interface PerfView {
  last: Report | null;
  running: Result | null;
  results: Result[];
  visible: number;
  max_visible: number;
  waiting: number;
  is_demo: boolean;
  live_real: boolean;
  warmup_s: number;
  measure_s: number;
}

interface Health {
  server: {
    level: "ok" | "busy" | "overloaded";
    events_per_s: number;
    event_lag_ms_p95: number;
    loop_lag_ms_p95: number;
    cpu_pct: number | null;
    rss_mb: number | null;
    bus_depth: number;
    dropped_low_priority: number;
    shed: number;
  };
  loadtest: { rate: number; seconds: number; sent: number; achieved_rate: number; done: boolean; stopped: boolean } | null;
  avatars: { visible: number; waiting: number };
  game_clients: number;
  dashboard_clients: number;
}
const LEVEL: Record<string, { text: string; cls: string }> = {
  ok: { text: "Ổn định", cls: "ok" },
  busy: { text: "Bận — đang bớt việc phụ", cls: "" },
  overloaded: { text: "Quá tải — chỉ xử lý việc chính", cls: "bad" },
};

const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "–" : v.toFixed(d));
const QUALITY: Record<string, string> = { low: "thấp", medium: "vừa", high: "cao", ultra: "nét nhất" };

export function PerfCard() {
  const [v, setV] = useState<PerfView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [h, setH] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.get<PerfView>("/game/perf").then((r) => alive && setV(r)).catch(() => undefined);
      api.get<Health>("/system/health").then((r) => alive && setH(r)).catch(() => undefined);
    };
    load();
    const id = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const run = async (count: number) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await api.post<{ target: number; added: number }>("/game/benchmark", { count });
      setMsg(`Đang đo với ${r.target} Chibi (thêm ${r.added}) — khoảng ${(v?.warmup_s ?? 8) + (v?.measure_s ?? 20)} giây.`);
    } catch (x) {
      setMsg(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setMsg(null);
    try {
      const r = await api.post<{ left: number }>("/game/benchmark/clear");
      setMsg(`${r.left} Chibi đã ra về.`);
    } catch (x) {
      setMsg(x instanceof ApiError ? x.message : String(x));
    }
  };
  const loadTest = async (rate: number) => {
    setMsg(null);
    try {
      await api.post("/game/loadtest", { rate, seconds: 30, viewers: 3000 });
      setMsg(`Đang giả lập LIVE rất đông: ${rate} sự kiện mỗi giây trong 30 giây.`);
    } catch (x) {
      setMsg(x instanceof ApiError ? x.message : String(x));
    }
  };
  const last = v?.last;
  const fpsClass = !last?.fps ? "" : last.fps >= 28 ? "ok" : last.fps < 22 ? "bad" : "";
  return (
    <div className="stack" data-testid="perf-card">
      {!last ? (
        <p className="muted">Chưa có số đo — mở màn hình game /game/live trên máy phát LIVE, số liệu hiện sau vài giây.</p>
      ) : (
        <>
          <div className="perf-grid">
            <div className={`perf-cell ${fpsClass}`} data-testid="perf-fps">
              <b>{fmt(last.fps, 1)}</b>
              <span>khung hình/giây (nên ≥ 30)</span>
            </div>
            <div className="perf-cell">
              <b>{fmt(last.frame_ms_p95, 0)} ms</b>
              <span>khung chậm nhất (5%)</span>
            </div>
            <div className="perf-cell">
              <b>{fmt(last.sim_ms, 2)} ms</b>
              <span>CPU cho hành vi Chibi mỗi khung</span>
            </div>
            <div className="perf-cell">
              <b>{fmt(last.render_calls)}</b>
              <span>lệnh vẽ GPU mỗi khung</span>
            </div>
            <div className="perf-cell">
              <b>{last.heap_mb === null ? "–" : `${fmt(last.heap_mb)} MB`}</b>
              <span>bộ nhớ trang game</span>
            </div>
            <div className="perf-cell" data-testid="perf-avatars">
              <b>
                {v.visible}/{v.max_visible}
              </b>
              <span>Chibi trên màn hình{v.waiting ? ` · ${v.waiting} chờ ngoài cửa` : ""}</span>
            </div>
          </div>
          <p className="muted small">
            Chi tiết: {last.lod.full} Chibi vẽ đầy đủ · {last.lod.reduced} giảm viền · {last.lod.far} ở xa (ít chi tiết) · {last.lod.hidden} ngoài khung hình. Chất lượng{" "}
            {QUALITY[last.quality] ?? last.quality}. Card đồ họa: {last.gpu ?? "không rõ"}.
          </p>
          <Sharpness last={last} />
        </>
      )}
      <div className="row wrap">
        <button type="button" className="primary" disabled={busy || !!v?.live_real} onClick={() => run(30)} data-testid="bench-30">
          Đo thử với 30 Chibi
        </button>
        <button type="button" disabled={busy || !!v?.live_real} onClick={() => run(50)} data-testid="bench-50">
          Đo thử với 50 Chibi
        </button>
        <button type="button" disabled={!v?.is_demo} onClick={clear} data-testid="bench-clear">
          Cho tất cả Chibi ra về
        </button>
        {msg && <span className="muted" data-testid="bench-msg">{msg}</span>}
      </div>
      {v?.live_real && <p className="muted small">Đang LIVE thật — chỉ đo thử khi chạy Demo.</p>}
      {h && (
        <div className="stack" data-testid="server-health">
          <h4 className="perf-sub">Máy chủ khi LIVE đông</h4>
          <div className="perf-grid">
            <div className={`perf-cell ${LEVEL[h.server.level]?.cls ?? ""}`} data-testid="server-level">
              <b>{LEVEL[h.server.level]?.text ?? h.server.level}</b>
              <span>tình trạng</span>
            </div>
            <div className="perf-cell">
              <b>{fmt(h.server.events_per_s)}</b>
              <span>sự kiện xử lý mỗi giây</span>
            </div>
            <div className="perf-cell">
              <b>{fmt(h.server.event_lag_ms_p95)} ms</b>
              <span>chậm nhất từ lúc nhận tới lúc xử lý</span>
            </div>
            <div className="perf-cell">
              <b>{h.server.cpu_pct === null ? "–" : `${fmt(h.server.cpu_pct)} %`}</b>
              <span>CPU máy chủ (100 % = một nhân)</span>
            </div>
            <div className="perf-cell">
              <b>{h.server.rss_mb === null ? "–" : `${fmt(h.server.rss_mb)} MB`}</b>
              <span>bộ nhớ máy chủ</span>
            </div>
            <div className="perf-cell">
              <b>{h.avatars.waiting}</b>
              <span>người chờ vào quán</span>
            </div>
          </div>
          {(h.server.dropped_low_priority > 0 || h.server.shed > 0) && (
            <p className="muted small">
              Đã bỏ {h.server.dropped_low_priority} lượt thả tim/vào xem khi quá đông và {h.server.shed} việc phụ (trò chuyện tự động, trả lời khi quá nhiều câu hỏi). Bình luận, quà và lệnh không bao giờ bị bỏ.
            </p>
          )}
          <div className="row wrap">
            {[200, 500, 1000].map((r) => (
              <button key={r} type="button" disabled={!!v?.live_real || (h.loadtest !== null && !h.loadtest.done)} onClick={() => loadTest(r)} data-testid={`load-${r}`}>
                Giả lập {r} sự kiện/giây
              </button>
            ))}
            {h.loadtest && !h.loadtest.done && (
              <button type="button" onClick={() => api.post("/game/loadtest/stop")}>
                Dừng giả lập
              </button>
            )}
          </div>
          {h.loadtest && (
            <p className="muted small" data-testid="loadtest-status">
              {h.loadtest.done ? "Đã giả lập xong" : "Đang giả lập"}: {h.loadtest.sent} sự kiện, trung bình {fmt(h.loadtest.achieved_rate)}/giây.
            </p>
          )}
        </div>
      )}
      {v?.running && <p className="muted small">Đang đo… {v.running.samples} lần đọc.</p>}
      {v && v.results.length > 0 && (
        <table className="perf-table" data-testid="bench-results">
          <thead>
            <tr>
              <th>Chibi</th>
              <th>FPS trung bình</th>
              <th>FPS thấp nhất</th>
              <th>Khung chậm (ms)</th>
              <th>CPU Chibi (ms)</th>
              <th>Lệnh vẽ</th>
              <th>Bộ nhớ</th>
            </tr>
          </thead>
          <tbody>
            {[...v.results].reverse().map((r, i) => (
              <tr key={i}>
                <td>{r.avatars}</td>
                <td>{fmt(r.fps_avg, 1)}</td>
                <td>{fmt(r.fps_min, 1)}</td>
                <td>{fmt(r.frame_ms_p95)}</td>
                <td>{fmt(r.sim_ms, 2)}</td>
                <td>{fmt(r.render_calls)}</td>
                <td>{r.heap_mb === null ? "–" : `${fmt(r.heap_mb)} MB`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Is the game window big enough for a sharp 1080 × 1920 LIVE picture? */
function Sharpness({ last }: { last: Report }) {
  const win = last.window_px;
  if (!win) return null;
  const [w, h] = win;
  const sharp = h >= 1900;
  const render = last.render_px;
  return (
    <p className={sharp ? "muted small" : "warn-text small"} data-testid="perf-sharpness" data-sharp={sharp ? "1" : "0"}>
      Cửa sổ game: <b>{w} × {h}</b> điểm ảnh
      {render && (render[0] !== w || render[1] !== h) ? <> (vẽ ở {render[0]} × {render[1]} rồi thu nhỏ cho nét)</> : null}.{" "}
      {sharp
        ? "Đủ khung LIVE 1080 × 1920 — hình trên điện thoại sẽ nét."
        : `Nhỏ hơn khung LIVE 1080 × 1920: phần mềm LIVE phải phóng to ${(1920 / Math.max(1, h)).toFixed(1)} lần nên hình trên điện thoại bị mờ. Trong cửa sổ Chibi Live Game: chuột phải → “Nét nhất cho LIVE (1080 × 1920)”, hoặc dùng nguồn Link / Browser Source 1080 × 1920.`}
    </p>
  );
}
