// Dashboard → "Nhật ký lỗi": every warning and error of the server and of the pages, live.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

export interface LogRecord {
  id: number;
  first_at: string;
  last_at: string;
  level: "ERROR" | "WARNING" | "CRITICAL" | "INFO";
  area: string;
  logger: string;
  message: string;
  detail: string | null;
  count: number;
  context: Record<string, string>;
}
export interface LogStats {
  unseen: number;
  last_id: number;
  errors_24h: number;
  warnings_24h: number;
  by_area_24h: Record<string, number>;
}

const LEVEL_LABEL: Record<string, string> = { CRITICAL: "Nghiêm trọng", ERROR: "Lỗi", WARNING: "Cảnh báo", INFO: "Thông tin" };
const fmt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour12: false });

function asText(r: LogRecord) {
  const ctx = Object.entries(r.context)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return `#${r.id} [${r.level}] ${r.first_at}${r.count > 1 ? ` → ${r.last_at} (×${r.count})` : ""} ${r.area} (${r.logger})\n${r.message}${ctx ? `\n${ctx}` : ""}${r.detail ? `\n${r.detail}` : ""}`;
}

function Row({ r, isNew }: { r: LogRecord; isNew: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <li className={`log-row lv-${r.level.toLowerCase()}${isNew ? " unseen" : ""}`} data-testid="log-row">
      <div className="log-head" onClick={() => setOpen(!open)}>
        <span className={`chip lv-chip-${r.level.toLowerCase()}`}>{LEVEL_LABEL[r.level] ?? r.level}</span>
        <span className="chip">{r.area}</span>
        <span className="log-msg">{r.message}</span>
        {r.count > 1 && <span className="chip chip-muted" title={`Lần đầu ${fmt(r.first_at)}`}>×{r.count}</span>}
        <span className="muted small log-time">{fmt(r.last_at)}</span>
      </div>
      {open && (
        <div className="log-detail">
          <div className="muted small">
            Mã #{r.id} · nguồn <code>{r.logger}</code> · lần đầu {fmt(r.first_at)}
            {r.count > 1 ? ` · lặp lại ${r.count} lần, lần cuối ${fmt(r.last_at)}` : ""}
          </div>
          {Object.keys(r.context).length > 0 && (
            <div className="small">
              {Object.entries(r.context).map(([k, v]) => (
                <div key={k}>
                  <b>{k}:</b> {v}
                </div>
              ))}
            </div>
          )}
          {r.detail && <pre className="log-trace">{r.detail}</pre>}
          <button
            className="small"
            onClick={() => {
              void navigator.clipboard?.writeText(asText(r)).then(() => setCopied(true));
            }}
          >
            {copied ? "Đã chép" : "Chép để gửi hỗ trợ"}
          </button>
        </div>
      )}
    </li>
  );
}

export function LogsPage({ live, stats, onSeen }: { live: LogRecord[]; stats: LogStats | null; onSeen: (s: LogStats) => void }) {
  const [items, setItems] = useState<LogRecord[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [level, setLevel] = useState<"WARNING" | "ERROR">("WARNING");
  const [area, setArea] = useState("");
  const [q, setQ] = useState("");
  const [seenAtOpen, setSeenAtOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams({ level, limit: "500" });
    if (area) p.set("area", area);
    if (q) p.set("q", q);
    api.get<{ items: LogRecord[]; stats: LogStats; areas: string[] }>(`/logs?${p}`).then((d) => {
      setItems(d.items);
      setAreas(d.areas);
      setSeenAtOpen((s) => (s === null ? d.stats.last_id - d.stats.unseen : s));
      if (d.stats.unseen > 0) api.post<{ stats: LogStats }>("/logs/seen", { id: d.stats.last_id }).then((r) => onSeen(r.stats));
    });
  }, [level, area, q, onSeen]);
  useEffect(load, [load]);

  // live records (new or with a higher count) merged on top, respecting the filters
  const shown = useMemo(() => {
    const byId = new Map(items.map((r) => [r.id, r]));
    const ql = q.toLowerCase();
    for (const r of live) {
      const okLevel = level === "WARNING" ? r.level !== "INFO" : r.level === "ERROR" || r.level === "CRITICAL";
      const okArea = !area || r.area === area;
      const okQ = !ql || r.message.toLowerCase().includes(ql) || (r.detail ?? "").toLowerCase().includes(ql);
      if (okLevel && okArea && okQ) byId.set(r.id, r);
    }
    return [...byId.values()].sort((a, b) => b.last_at.localeCompare(a.last_at) || b.id - a.id);
  }, [items, live, level, area, q]);

  useEffect(() => {
    if (stats && stats.unseen > 0 && live.length) api.post<{ stats: LogStats }>("/logs/seen", { id: stats.last_id }).then((r) => onSeen(r.stats));
  }, [live.length, stats, onSeen]);

  return (
    <div className="stack">
      <div className="card row wrap" data-testid="log-stats">
        <span className={`chip ${stats?.errors_24h ? "chip-err" : "chip-ok"}`}>24 giờ qua: {stats?.errors_24h ?? 0} lỗi</span>
        <span className={`chip ${stats?.warnings_24h ? "chip-warn" : "chip-ok"}`}>{stats?.warnings_24h ?? 0} cảnh báo</span>
        {stats &&
          Object.entries(stats.by_area_24h)
            .slice(0, 6)
            .map(([a, n]) => (
              <button key={a} className={`chip chip-btn${area === a ? " sel" : ""}`} onClick={() => setArea(area === a ? "" : a)}>
                {a}: {n}
              </button>
            ))}
      </div>
      <div className="row wrap log-toolbar">
        <select value={level} onChange={(e) => setLevel(e.target.value as "WARNING" | "ERROR")} aria-label="Mức độ">
          <option value="WARNING">Lỗi và cảnh báo</option>
          <option value="ERROR">Chỉ lỗi</option>
        </select>
        <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Khu vực">
          <option value="">Mọi khu vực</option>
          {areas.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm trong nội dung lỗi" aria-label="Tìm lỗi" />
        <span className="grow" />
        <a className="button small" href="/api/v1/logs/export.txt" download>
          ⬇ Tải toàn bộ nhật ký (.txt)
        </a>
        <button
          className="small"
          onClick={() =>
            confirm("Xóa toàn bộ nhật ký lỗi? (Không ảnh hưởng dữ liệu bán hàng)") &&
            api.post<{ stats: LogStats }>("/logs/clear").then((r) => {
              setItems([]);
              onSeen(r.stats);
            })
          }
        >
          Xóa nhật ký
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted" data-testid="log-empty">
          Chưa có lỗi nào. Mọi lỗi và cảnh báo khi phần mềm chạy (Claude, Vbee, TikTok, cơ sở dữ liệu, trang game, dashboard…) sẽ hiện ở đây ngay khi xảy ra.
        </p>
      ) : (
        <ul className="log-list">
          {shown.map((r) => (
            <Row key={r.id} r={r} isNew={seenAtOpen !== null && r.id > seenAtOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}
