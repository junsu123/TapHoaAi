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

const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "–" : v.toFixed(d));
const QUALITY: Record<string, string> = { low: "thấp", medium: "vừa", high: "cao" };

export function PerfCard() {
  const [v, setV] = useState<PerfView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<PerfView>("/game/perf").then((r) => alive && setV(r)).catch(() => undefined);
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
