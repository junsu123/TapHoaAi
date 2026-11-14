// Dashboard → "Hội thoại & câu đã học": the log of every LIVE question/answer, and the answers the
// shop confirmed, which the LIVE reuses for similar questions without calling Claude.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";

interface Variant {
  id: number;
  question: string;
}
interface Entry {
  id: number;
  product_id: string | null;
  product_name: string | null;
  intent: string | null;
  answer: string;
  enabled: boolean;
  trusted: boolean;
  source: "host" | "auto" | "manual";
  uses: number;
  last_used_at: string | null;
  variants: Variant[];
}
interface Turn {
  id: number;
  event_id: string;
  session_id: string | null;
  is_demo: boolean;
  asked_at: string | null;
  nickname: string | null;
  question: string;
  product_id: string | null;
  draft: string | null;
  draft_source: string | null;
  answer: string | null;
  answered_by: string | null;
  status: string;
  spoken: boolean;
  knowledge_id: number | null;
  cost_usd: number;
}
interface SessionRow {
  session_id: string | null;
  questions: number;
  first_at: string | null;
  last_at: string | null;
  is_demo: boolean;
  provider: string | null;
  unique_id: string | null;
}
interface Stats {
  answered_without_claude_24h: number;
  claude_calls_24h: number;
  learned: number;
  pending_review: number;
}
interface ProductLite {
  id: string;
  name: string;
}

const SOURCE: Record<string, string> = {
  claude: "Claude",
  cache: "Claude (dùng lại)",
  memory: "Câu đã học",
  template: "Câu mẫu",
  host: "Người trực",
  auto: "Tự động (Claude)",
};
const ENTRY_SOURCE: Record<Entry["source"], string> = { host: "người trực xác nhận", auto: "Claude tự đọc", manual: "tự thêm" };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("vi-VN", { hour12: false }) : "");
const showPrice = (s: string) => s.replace(/\{gia\}/g, "‹giá hiện tại›");

function msg(x: unknown) {
  return x instanceof ApiError ? x.message : String(x);
}

function EntryCard({ e, onChange }: { e: Entry; onChange: () => void }) {
  const [answer, setAnswer] = useState(e.answer);
  const [addQ, setAddQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setAnswer(e.answer), [e.answer]);
  const patch = (body: object) =>
    api
      .patch(`/knowledge/${e.id}`, body)
      .then(onChange)
      .catch((x) => setErr(msg(x)));
  return (
    <li className={`kn-entry${e.enabled ? "" : " off"}${e.trusted ? "" : " pending"}`} data-testid="kn-entry">
      <div className="row wrap">
        {!e.trusted ? <span className="chip chip-warn">Chờ duyệt</span> : e.enabled ? <span className="chip chip-ok">Đang dùng</span> : <span className="chip chip-muted">Đã tắt</span>}
        <span className="chip">{e.product_name ?? "Câu hỏi chung"}</span>
        <span className="muted small">
          {ENTRY_SOURCE[e.source]} · đã dùng {e.uses} lần{e.last_used_at ? ` · lần cuối ${fmt(e.last_used_at)}` : ""}
        </span>
      </div>
      <div className="kn-variants">
        {e.variants.map((v) => (
          <span className="kn-q" key={v.id}>
            “{v.question}”
            <button className="link" title="Bỏ cách hỏi này" aria-label={`Bỏ câu hỏi ${v.question}`} onClick={() => api.del(`/knowledge/${e.id}/variants/${v.id}`).then(onChange)}>
              ✕
            </button>
          </span>
        ))}
        <input className="kn-addq" value={addQ} onChange={(x) => setAddQ(x.target.value)} placeholder="+ thêm cách hỏi khác" aria-label="Thêm cách hỏi" onKeyDown={(x) => x.key === "Enter" && addQ.trim() && patch({ add_question: addQ.trim() }).then(() => setAddQ(""))} />
      </div>
      <textarea rows={2} maxLength={280} value={showPrice(answer)} onChange={(x) => setAnswer(x.target.value.replace(/‹giá hiện tại›/g, "{gia}"))} aria-label="Câu trả lời" />
      <div className="row wrap">
        {answer !== e.answer && (
          <button className="primary small" onClick={() => patch({ answer: answer.replace(/‹giá hiện tại›/g, "{gia}") })}>
            Lưu câu trả lời
          </button>
        )}
        {!e.trusted && (
          <button className="primary small" onClick={() => patch({ trusted: true })} data-testid="kn-approve">
            ✓ Duyệt — cho tự trả lời
          </button>
        )}
        <button className="small" onClick={() => patch({ enabled: !e.enabled })}>
          {e.enabled ? "Tắt" : "Bật lại"}
        </button>
        <button className="small" onClick={() => confirm("Xóa câu đã học này?") && api.del(`/knowledge/${e.id}`).then(onChange)}>
          Xóa
        </button>
      </div>
      {err && <p className="error small">{err}</p>}
    </li>
  );
}

function KnowledgeTab({ products, reloadStats }: { products: ProductLite[]; reloadStats: () => void }) {
  const [items, setItems] = useState<Entry[]>([]);
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [newQ, setNewQ] = useState("");
  const [newA, setNewA] = useState("");
  const [newP, setNewP] = useState("");
  const [testQ, setTestQ] = useState("");
  const [test, setTest] = useState<{ matched: boolean; score?: number; answer?: string | null; matched_question?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (filter) p.set("status", filter);
    if (q) p.set("q", q);
    api.get<{ items: Entry[] }>(`/knowledge?${p}`).then((d) => setItems(d.items));
    reloadStats();
  }, [filter, q, reloadStats]);
  useEffect(load, [load]);

  const add = () =>
    api
      .post("/knowledge", { questions: newQ.split("\n").map((x) => x.trim()).filter(Boolean), product_id: newP || null, answer: newA })
      .then(() => {
        setNewQ("");
        setNewA("");
        setErr(null);
        load();
      })
      .catch((x) => setErr(msg(x)));

  return (
    <div className="two-col">
      <div className="stack">
        <div className="row wrap">
          {[
            ["", "Tất cả"],
            ["trusted", "Đang dùng"],
            ["pending", "Chờ duyệt"],
            ["disabled", "Đã tắt"],
          ].map(([v, l]) => (
            <button key={v} className={filter === v ? "primary small" : "small"} onClick={() => setFilter(v)}>
              {l}
            </button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm câu hỏi/câu trả lời" aria-label="Tìm câu đã học" />
        </div>
        {items.length === 0 && <p className="muted">Chưa có câu nào. Mỗi lần người trực bấm “Đọc” một câu trả lời, phần mềm sẽ tự học câu đó.</p>}
        <ul className="kn-list">
          {items.map((e) => (
            <EntryCard key={e.id} e={e} onChange={load} />
          ))}
        </ul>
      </div>
      <div className="stack">
        <div className="card">
          <h3>Thử một câu hỏi</h3>
          <div className="row">
            <input className="grow" value={testQ} onChange={(e) => setTestQ(e.target.value)} placeholder="vd: cà gai leo uống ntn vậy shop" aria-label="Câu hỏi thử" />
            <button onClick={() => api.post<typeof test>("/knowledge/test", { question: testQ }).then(setTest)} disabled={!testQ.trim()}>
              Thử
            </button>
          </div>
          {test && (
            <div className={`test-result ${test.matched ? "ok" : "bad"}`} data-testid="kn-test">
              {test.matched ? (
                <>
                  <b>Tự trả lời, không gọi Claude</b> (giống “{test.matched_question}” {Math.round((test.score ?? 0) * 100)}%)
                  <div>“{test.answer ?? "— câu này đang bị chặn (giá chưa xác nhận hoặc nội dung không an toàn)"}”</div>
                </>
              ) : (
                <b>Chưa có câu đã học đủ giống{test.score ? ` (gần nhất ${Math.round(test.score * 100)}%)` : ""} — sẽ hỏi Claude.</b>
              )}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Tự thêm câu trả lời</h3>
          <div className="stack">
            <label className="field">
              <span>Các cách hỏi (mỗi dòng một câu)</span>
              <textarea rows={3} value={newQ} onChange={(e) => setNewQ(e.target.value)} placeholder={"shop có ship COD không\ncó nhận hàng rồi trả tiền không"} aria-label="Các cách hỏi" />
            </label>
            <label className="field">
              <span>Sản phẩm</span>
              <select value={newP} onChange={(e) => setNewP(e.target.value)} aria-label="Sản phẩm của câu hỏi">
                <option value="">— câu hỏi chung (ship, thanh toán…) —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Câu trả lời</span>
              <textarea rows={2} maxLength={280} value={newA} onChange={(e) => setNewA(e.target.value)} aria-label="Câu trả lời mới" />
              <span className="muted small">Ghi giá đúng như hiện tại — phần mềm tự đổi theo giá mới khi bạn sửa giá sản phẩm.</span>
            </label>
            <button className="primary" onClick={add} disabled={!newQ.trim() || newA.trim().length < 2}>
              Thêm
            </button>
            {err && <p className="error small">{err}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryTab({ reloadStats }: { reloadStats: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sid, setSid] = useState<string>("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Turn[]>([]);
  const [total, setTotal] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ sessions: SessionRow[] }>("/conversations/sessions").then((d) => setSessions(d.sessions));
  }, []);
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (sid) p.set("session_id", sid);
    if (q) p.set("q", q);
    api.get<{ total: number; items: Turn[] }>(`/conversations?${p}`).then((d) => {
      setRows(d.items);
      setTotal(d.total);
    });
  }, [sid, q]);
  useEffect(load, [load]);
  const teach = (t: Turn) =>
    api
      .post("/knowledge", { questions: [t.question], product_id: t.product_id, answer: t.answer ?? t.draft })
      .then(() => {
        setNote(`Đã lưu thành câu đã học: “${t.question}”`);
        reloadStats();
      })
      .catch((x) => setNote(msg(x)));
  return (
    <div className="stack">
      <div className="row wrap">
        <select value={sid} onChange={(e) => setSid(e.target.value)} aria-label="Phiên LIVE">
          <option value="">Tất cả phiên</option>
          {sessions.map((s) => (
            <option key={s.session_id ?? "none"} value={s.session_id ?? ""}>
              {fmt(s.first_at)} · {s.questions} câu hỏi{s.is_demo ? " · DEMO" : ""}
              {s.unique_id ? ` · @${s.unique_id}` : ""}
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm trong hội thoại" aria-label="Tìm trong hội thoại" />
        <a className="button small" href={`/api/v1/conversations/export.csv${sid ? `?session_id=${encodeURIComponent(sid)}` : ""}`} download>
          ⬇ Tải CSV (mở bằng Excel)
        </a>
        <span className="muted small">{total} câu hỏi</span>
      </div>
      {note && <p className="ok-text small">{note}</p>}
      <table className="conv-table" data-testid="conv-table">
        <thead>
          <tr>
            <th>Lúc</th>
            <th>Khách</th>
            <th>Câu hỏi</th>
            <th>Câu trả lời</th>
            <th>Nguồn</th>
            <th>Trạng thái</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="small">{fmt(t.asked_at)}</td>
              <td>{t.nickname ?? <span className="muted">(đã ẩn)</span>}</td>
              <td>{t.question}</td>
              <td>
                {t.answer ?? (t.draft ? <span className="muted">Gợi ý: {t.draft}</span> : <span className="muted">—</span>)}
                {t.spoken && <span title="Đã đọc trên LIVE"> 🔊</span>}
              </td>
              <td>
                <span className="chip">{SOURCE[t.answered_by ?? ""] ?? SOURCE[t.draft_source ?? ""] ?? "—"}</span>
                {t.cost_usd > 0 && <div className="muted small">{(t.cost_usd * 100).toFixed(3)} cent</div>}
              </td>
              <td className="small">{t.status}</td>
              <td>
                {(t.answer || t.draft) && !t.knowledge_id && (
                  <button className="small" onClick={() => teach(t)} title="Lần sau câu hỏi giống thế này sẽ tự trả lời">
                    Lưu thành câu đã học
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KnowledgePage() {
  const [tab, setTab] = useState<"knowledge" | "history">("knowledge");
  const [stats, setStats] = useState<Stats | null>(null);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const reloadStats = useCallback(() => {
    api.get<Stats>("/conversations/stats").then(setStats);
  }, []);
  useEffect(() => {
    reloadStats();
    api.get<ProductLite[]>("/products").then(setProducts);
  }, [reloadStats]);
  return (
    <div className="stack">
      {stats && (
        <div className="card row wrap" data-testid="kn-stats">
          <span className="chip chip-ok">24 giờ qua: {stats.answered_without_claude_24h} câu tự trả lời, không gọi Claude</span>
          <span className="chip chip-ai">{stats.claude_calls_24h} câu hỏi Claude</span>
          <span className="chip">{stats.learned} câu đã học</span>
          {stats.pending_review > 0 && <span className="chip chip-warn">{stats.pending_review} câu chờ duyệt</span>}
        </div>
      )}
      <div className="row">
        <button className={tab === "knowledge" ? "primary" : ""} onClick={() => setTab("knowledge")}>
          Câu đã học
        </button>
        <button className={tab === "history" ? "primary" : ""} onClick={() => setTab("history")}>
          Lịch sử hội thoại LIVE
        </button>
      </div>
      {tab === "knowledge" ? <KnowledgeTab products={products} reloadStats={reloadStats} /> : <HistoryTab reloadStats={reloadStats} />}
    </div>
  );
}
