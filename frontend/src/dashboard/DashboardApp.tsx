// Vietnamese operator dashboard (SPEC I). Only features that really work are shown;
// later milestones are labelled as such instead of being faked.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, formatVnd, setCsrf } from "../lib/api";
import { useDashboardFeed, type CommentRecord, type HostItem, type LiveStatus, type Metrics } from "./useDashboardFeed";

interface Me {
  username: string;
  role: string;
  csrf_token: string;
}

const INTENT_LABEL: Record<string, string> = {
  PRODUCT: "Sản phẩm",
  QUESTION: "Câu hỏi",
  AMBIGUOUS: "Mơ hồ",
  GREETING: "Chào",
  DANCE: "Nhảy",
  SPAM: "Spam",
  NONE: "Khác",
};

function StatusPill({ status }: { status: string }) {
  const kind =
    status === "Đã kết nối" ? "ok" : ["Mất kết nối", "Đã kết thúc", "Không hỗ trợ", "Không phát LIVE"].includes(status) ? "bad" : "mid";
  const icon = kind === "ok" ? "●" : kind === "bad" ? "▲" : "○";
  return (
    <span className={`pill pill-${kind}`} data-testid="live-status">
      {icon} {status}
    </span>
  );
}

function ErrorText({ err }: { err: string | null }) {
  return err ? (
    <p className="error" role="alert">
      {err}
    </p>
  ) : null;
}

// ------------------------------------------------------------------ auth gate
function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ setup_required: boolean }>("/auth/setup").then((r) => setSetup(r.setup_required), () => setSetup(false));
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const me = await api.post<Me>(setup ? "/auth/setup" : "/auth/login", { username, password });
      onLogin(me);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Không kết nối được máy chủ.");
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Chibi Live Shop</h1>
        <p className="muted">{setup ? "Tạo tài khoản quản trị đầu tiên (chỉ trên máy chạy phần mềm)." : "Đăng nhập trang quản trị"}</p>
        <label>
          Tên đăng nhập
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Mật khẩu{setup ? " (ít nhất 10 ký tự)" : ""}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} required />
        </label>
        <ErrorText err={err} />
        <button type="submit" className="primary">
          {setup ? "Tạo tài khoản" : "Đăng nhập"}
        </button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ pages
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Overview({ live, metrics }: { live: LiveStatus | null; metrics: Metrics | null }) {
  const lat = metrics?.actions?.latency;
  return (
    <div className="grid">
      <Card title="Trạng thái LIVE">
        <StatusPill status={live?.status ?? "Chưa kết nối"} />
        {live?.is_demo && <p className="muted">Đang chạy chế độ Demo (sự kiện mô phỏng).</p>}
      </Card>
      <Card title="Chibi">
        <p className="big">{metrics?.avatars?.visible ?? 0}</p>
        <p className="muted">đang hiển thị · {metrics?.avatars?.overflow ?? 0} chờ vào</p>
      </Card>
      <Card title="Bình luận">
        <p className="big">{metrics?.events?.COMMENT ?? 0}</p>
        <p className="muted">{metrics?.comments_per_s ?? 0} bình luận/giây (60 s gần nhất)</p>
      </Card>
      <Card title="Độ trễ lệnh game">
        <p className="big">{lat?.p50_ms != null ? `${lat.p50_ms} ms` : "—"}</p>
        <p className="muted">p95: {lat?.p95_ms != null ? `${lat.p95_ms} ms` : "—"} · {lat?.samples ?? 0} mẫu</p>
      </Card>
      <Card title="Game 3D">
        <p className="big">{metrics?.game_fps?.last ? `${metrics.game_fps.last} FPS` : "—"}</p>
        <p className="muted">{metrics?.game_clients?.primary ? "Cửa sổ game chính đang mở" : "Chưa mở cửa sổ game /game/live"}</p>
      </Card>
      <Card title="Số người xem">
        <p className="big">{metrics?.viewer_count ?? "—"}</p>
        <p className="muted">{metrics?.viewer_count == null ? "Nguồn hiện tại không cung cấp" : "Theo nguồn sự kiện"}</p>
      </Card>
      <Card title="Claude AI">
        <p>Chưa cấu hình — mốc M4.</p>
        <p className="muted">Bình luận sản phẩm vẫn được xử lý bằng bộ luật, không tốn chi phí API.</p>
      </Card>
      <Card title="Đơn hàng TikTok Shop">
        <p>Chưa kết nối Shop (mốc M6).</p>
        <p className="muted">Không suy ra đơn hàng từ bình luận hay quà tặng.</p>
      </Card>
    </div>
  );
}

function ConnectPage({ live }: { live: LiveStatus | null }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <Card title="Kết nối TikTok LIVE">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.post("/live/connect", { url }));
          }}
        >
          <input
            aria-label="Link TikTok LIVE"
            placeholder="https://www.tiktok.com/@tên_tài_khoản/live"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="grow"
          />
          <button className="primary" disabled={busy || !url}>
            Kết nối
          </button>
          <button type="button" onClick={() => run(() => api.post("/live/disconnect"))} disabled={busy}>
            Ngắt kết nối
          </button>
        </form>
        <ErrorText err={err} />
        <p className="muted">
          Kết nối TikTok thật thuộc mốc M3 và hiện báo “Không hỗ trợ”. Hệ thống không bao giờ báo “Đã kết nối” khi nguồn chưa xác nhận.
        </p>
      </Card>
      <Card title="Chế độ Demo">
        <div className="row">
          <button className="primary" onClick={() => run(() => api.post("/demo/start"))} disabled={busy}>
            Bật Demo
          </button>
          <span className="muted">Dùng cùng đường ống sự kiện với LIVE thật; mọi người xem giả đều có nhãn DEMO.</span>
        </div>
      </Card>
      <Card title="Trạng thái">
        <StatusPill status={live?.status ?? "Chưa kết nối"} />
        {live?.detail && <p>{live.detail}</p>}
        <dl className="kv">
          <dt>Nguồn</dt>
          <dd>{live?.provider ?? "—"}</dd>
          <dt>Tài khoản</dt>
          <dd>{live?.unique_id ?? "—"}</dd>
          <dt>Phiên</dt>
          <dd>{live?.session_id ?? "—"}</dd>
        </dl>
        {live && Object.keys(live.capabilities).length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Loại sự kiện</th>
                <th>Khả dụng</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(live.capabilities).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {live && live.reconnect_log.length > 0 && (
          <>
            <h3>Nhật ký kết nối lại</h3>
            <ul>
              {live.reconnect_log.map((r, i) => (
                <li key={i}>
                  {new Date(r.at).toLocaleTimeString("vi-VN")} — lần {r.attempt}: {r.error}
                  {r.retry_in_s ? ` (thử lại sau ${r.retry_in_s}s)` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function CommentRow({ c }: { c: CommentRecord }) {
  return (
    <li className="comment" data-testid="comment-row">
      <span className={`chip chip-${c.intent.toLowerCase()}`}>{INTENT_LABEL[c.intent] ?? c.intent}</span>
      <b>{c.nickname ?? c.unique_id ?? "?"}</b>
      {c.is_demo && <span className="chip">DEMO</span>}: {c.text}
      {c.product_name && <span className="muted"> → {c.product_name}</span>}
      {c.action_outcome === "no_location" && <span className="error"> (chưa gắn kệ)</span>}
    </li>
  );
}

function HostPage({ comments, host, aiPaused, setAiPaused }: { comments: CommentRecord[]; host: HostItem[]; aiPaused: boolean; setAiPaused: (b: boolean) => void }) {
  const [raw, setRaw] = useState("@lananh88: trà cà gai leo");
  const [err, setErr] = useState<string | null>(null);
  const send = async (body: object) => {
    setErr(null);
    try {
      await api.post("/demo/events", body);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  };
  const togglePause = useCallback(async () => {
    const r = await api.post<{ paused: boolean }>("/ai/pause", { paused: !aiPaused });
    setAiPaused(r.paused);
  }, [aiPaused, setAiPaused]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        togglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause]);
  return (
    <div className="two-col">
      <div className="stack">
        <Card title="Cần người trực xử lý">
          <div className="row">
            <button onClick={togglePause} aria-pressed={aiPaused}>
              {aiPaused ? "▶ Tiếp tục AI" : "⏸ Tạm dừng AI"}
            </button>
            <span className="muted">Phím tắt Ctrl+Shift+P. Tạm dừng AI không dừng bình luận hay game.</span>
          </div>
          {host.length === 0 && <p className="muted">Chưa có câu hỏi hoặc bình luận mơ hồ.</p>}
          <ul className="host-list">
            {host.map((h) => (
              <li key={h.event_id} data-testid="host-item">
                <div>
                  <span className="chip chip-warn">{h.status}</span> <b>{h.nickname}</b>: {h.text}
                </div>
                <div className="muted">{h.hint}</div>
                {h.candidates.length > 0 && <div className="muted">Có thể là: {h.candidates.map((c) => c.name).join(", ")}</div>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Gửi sự kiện Demo">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              send({ type: "COMMENT", raw });
            }}
          >
            <input aria-label="Bình luận demo" className="grow" value={raw} onChange={(e) => setRaw(e.target.value)} />
            <button className="primary">Gửi bình luận</button>
          </form>
          <div className="row wrap">
            <button onClick={() => send({ raw: "@lananh88: trà cà gai leo" })}>@lananh88: trà cà gai leo</button>
            <button onClick={() => send({ raw: "@minhtu: trà ba kích" })}>@minhtu: trà ba kích</button>
            <button onClick={() => send({ raw: "@khachle: trà" })}>@khachle: trà (mơ hồ)</button>
            <button onClick={() => send({ type: "SPAWN_RANDOM", count: 10 })}>+10 người xem giả</button>
            <button onClick={() => send({ type: "GIFT", unique_id: "lananh88", gift_name: "Hoa hồng", repeat_count: 5, repeat_end: true, streakable: true })}>
              Quà (kết thúc chuỗi ×5)
            </button>
          </div>
          <ErrorText err={err} />
        </Card>
      </div>
      <Card title="Bình luận realtime">
        <ul className="comment-list">
          {comments.map((c) => (
            <CommentRow key={c.event_id} c={c} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

interface Product {
  id: string;
  sku: string;
  name: string;
  price: number | null;
  price_verified_at: string | null;
  status: string;
  disclaimer: string | null;
  image_url: string | null;
  aliases: { id: number; alias: string; is_generic: boolean }[];
  location: { shelf_id: string; slot_id: string } | null;
}

function ProductEditor({ p, onSaved }: { p: Product | null; onSaved: () => void }) {
  const [f, setF] = useState({
    id: p?.id ?? "",
    sku: p?.sku ?? "",
    name: p?.name ?? "",
    price: p?.price?.toString() ?? "",
    status: p?.status ?? "draft",
    disclaimer: p?.disclaimer ?? "",
    aliases: p?.aliases.filter((a) => !a.is_generic).map((a) => a.alias).join(", ") ?? "",
    generic: p?.aliases.filter((a) => a.is_generic).map((a) => a.alias).join(", ") ?? "",
    verify: false,
  });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      let image_asset_id: number | undefined;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("kind", "image");
        image_asset_id = (await api.upload<{ id: number }>("/assets/upload", fd)).id;
      }
      const body = {
        sku: f.sku,
        name: f.name,
        price: f.price === "" ? null : Number(f.price),
        status: f.status,
        disclaimer: f.disclaimer || null,
        verify_price: f.verify,
        ...(image_asset_id ? { image_asset_id } : {}),
      };
      if (p) await api.patch(`/products/${p.id}`, body);
      else await api.post("/products", { id: f.id, ...body });
      const aliases = [
        ...f.aliases.split(",").map((a) => a.trim()).filter(Boolean).map((alias) => ({ alias })),
        ...f.generic.split(",").map((a) => a.trim()).filter(Boolean).map((alias) => ({ alias, is_generic: true })),
      ];
      await api.post(`/products/${p?.id ?? f.id}/aliases`, { aliases, replace: true });
      onSaved();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="editor" onSubmit={save}>
      {!p && (
        <label>
          Mã sản phẩm (A-Z, 0-9, _)
          <input value={f.id} onChange={set("id")} required />
        </label>
      )}
      <label>
        Tên
        <input value={f.name} onChange={set("name")} required />
      </label>
      <label>
        SKU
        <input value={f.sku} onChange={set("sku")} required />
      </label>
      <label>
        Giá (VND)
        <input type="number" min={0} value={f.price} onChange={set("price")} />
      </label>
      <label className="check">
        <input type="checkbox" checked={f.verify} onChange={(e) => setF({ ...f, verify: e.target.checked })} /> Tôi xác nhận giá này đúng (giá chỉ hiện trên LIVE khi đã xác nhận)
      </label>
      <label>
        Trạng thái duyệt
        <select value={f.status} onChange={set("status")}>
          <option value="draft">Nháp</option>
          <option value="approved">Đã duyệt</option>
          <option value="disabled">Ngừng</option>
        </select>
      </label>
      <label>
        Từ khóa (cách nhau bằng dấu phẩy)
        <input value={f.aliases} onChange={set("aliases")} placeholder="cà gai leo, trà gai leo" />
      </label>
      <label>
        Từ chung — luôn coi là mơ hồ
        <input value={f.generic} onChange={set("generic")} placeholder="trà" />
      </label>
      <label>
        Lưu ý / disclaimer
        <input value={f.disclaimer} onChange={set("disclaimer")} />
      </label>
      <label>
        Ảnh mặt trước hộp thật (PNG/JPEG/WebP ≤ 5 MB)
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <ErrorText err={err} />
      <button className="primary">Lưu</button>
    </form>
  );
}

function ProductsPage() {
  const [items, setItems] = useState<Product[]>([]);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const load = () => api.get<Product[]>("/products").then(setItems);
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="stack">
      <Card title="Sản phẩm">
        <button className="primary" onClick={() => setEditing("new")}>
          + Thêm sản phẩm
        </button>
        <table>
          <thead>
            <tr>
              <th>Ảnh</th>
              <th>Tên</th>
              <th>SKU</th>
              <th>Giá</th>
              <th>Duyệt</th>
              <th>Kệ</th>
              <th>Từ khóa</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.image_url ? <img className="thumb" src={p.image_url} alt="" /> : "—"}</td>
                <td>{p.name}</td>
                <td>{p.sku}</td>
                <td>
                  {formatVnd(p.price) ?? "—"}
                  {p.price != null && !p.price_verified_at && <div className="error">chưa xác nhận</div>}
                </td>
                <td>{p.status === "approved" ? "Đã duyệt" : p.status === "draft" ? "Nháp" : "Ngừng"}</td>
                <td>{p.location ? `${p.location.shelf_id}/${p.location.slot_id}` : "—"}</td>
                <td>{p.aliases.map((a) => a.alias + (a.is_generic ? "*" : "")).join(", ")}</td>
                <td>
                  <button onClick={() => setEditing(p)}>Sửa</button>{" "}
                  <button
                    onClick={async () => {
                      if (confirm(`Ẩn sản phẩm ${p.name}?`)) {
                        await api.del(`/products/${p.id}`);
                        load();
                      }
                    }}
                  >
                    Xóa
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">* từ chung: luôn hỏi lại khách thay vì đoán.</p>
      </Card>
      {editing && (
        <Card title={editing === "new" ? "Thêm sản phẩm" : `Sửa: ${editing.name}`}>
          <ProductEditor
            key={editing === "new" ? "new" : editing.id}
            p={editing === "new" ? null : editing}
            onSaved={() => {
              setEditing(null);
              load();
            }}
          />
        </Card>
      )}
    </div>
  );
}

interface ShelfRow {
  code: string;
  name: string;
  slots: { code: string; product_id: string | null }[];
}

function ShelvesPage() {
  const [shelves, setShelves] = useState<ShelfRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    api.get<ShelfRow[]>("/shelves").then(setShelves);
    api.get<Product[]>("/products").then(setProducts);
  };
  useEffect(load, []);
  return (
    <Card title="Bản đồ kệ">
      <p className="muted">Gắn mỗi sản phẩm vào một ô kệ. Thay đổi có hiệu lực ngay với bình luận mới. (Trình kéo-thả vị trí kệ: mốc M2.)</p>
      <ErrorText err={err} />
      <table>
        <thead>
          <tr>
            <th>Kệ</th>
            <th>Ô 1</th>
            <th>Ô 2</th>
            <th>Ô 3</th>
          </tr>
        </thead>
        <tbody>
          {shelves.map((s) => (
            <tr key={s.code}>
              <td>
                {s.name} <span className="muted">({s.code})</span>
              </td>
              {s.slots.map((sl) => (
                <td key={sl.code}>
                  <select
                    aria-label={`${s.code} ${sl.code}`}
                    value={sl.product_id ?? ""}
                    onChange={async (e) => {
                      setErr(null);
                      try {
                        await api.patch(`/shelves/${s.code}/slots/${sl.code}`, { product_id: e.target.value || null });
                        load();
                      } catch (x) {
                        setErr(x instanceof ApiError ? x.message : String(x));
                      }
                    }}
                  >
                    <option value="">— trống —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function GameSetupPage() {
  const [info, setInfo] = useState<{ remote_token: string } | null>(null);
  useEffect(() => {
    api.get<{ remote_token: string }>("/game/info").then(setInfo);
  }, []);
  const liveUrl = `${location.origin}/game/live`;
  return (
    <div className="two-col">
      <Card title="Xem trước (không điều khiển game chính)">
        <div className="preview">
          <iframe title="Xem trước game" src="/game/live?role=viewer&quality=low" />
        </div>
      </Card>
      <div className="stack">
        <Card title="Mở màn hình LIVE 9:16">
          <p>
            <a href="/game/live" target="_blank" rel="noreferrer">
              {liveUrl}
            </a>
          </p>
          <p className="muted">Mở đúng một cửa sổ này trên PC phát LIVE — nó là cửa sổ game chính, xác nhận mọi lệnh Chibi.</p>
          <p className="muted">Chất lượng: thêm ?quality=low|medium|high (mặc định tự giảm khi FPS &lt; 24).</p>
        </Card>
        <Card title="OBS Studio">
          <ol>
            <li>Thêm nguồn Browser Source, URL: {liveUrl}, kích thước 1080 × 1920, 30 FPS.</li>
            <li>Cảnh “Shop LIVE”: webcam + mic người thật là chính, game là lớp phụ.</li>
            <li>Không dùng điện thoại quay màn hình máy tính (gây sọc moiré).</li>
          </ol>
          <p className="muted">Mở game từ máy khác trong mạng: thêm ?token={info?.remote_token ?? "…"} vào URL.</p>
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shell
export function DashboardApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    api
      .get<Me>("/auth/me")
      .then((m) => {
        setCsrf(m.csrf_token);
        setMe(m);
      })
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, []);
  const feed = useDashboardFeed(me !== null);
  if (!checked) return null;
  if (!me)
    return (
      <Login
        onLogin={(m) => {
          setCsrf(m.csrf_token);
          setMe(m);
        }}
      />
    );
  const nav = [
    ["", "Tổng quan"],
    ["connect", "Kết nối TikTok"],
    ["host", "Người trực & Demo"],
    ["products", "Sản phẩm"],
    ["shelves", "Bản đồ kệ"],
    ["game", "Game 3D & OBS"],
  ];
  return (
    <div className="dash">
      <aside>
        <div className="brand">Chibi Live Shop</div>
        <nav>
          {nav.map(([to, label]) => (
            <NavLink key={to} to={`/dashboard/${to}`} end={to === ""}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="muted small">
          {me.username} · {feed.connected ? "realtime ✓" : "đang kết nối…"}
        </div>
        <button
          onClick={async () => {
            await api.post("/auth/logout");
            setMe(null);
          }}
        >
          Đăng xuất
        </button>
      </aside>
      <main>
        {feed.live && feed.live.status === "Mất kết nối" && <div className="banner">⚠ Mất kết nối TikTok — đang thử lại. Không có sự kiện giả nào được tạo.</div>}
        <Routes>
          <Route index element={<Overview live={feed.live} metrics={feed.metrics} />} />
          <Route path="connect" element={<ConnectPage live={feed.live} />} />
          <Route path="host" element={<HostPage comments={feed.comments} host={feed.host} aiPaused={feed.aiPaused} setAiPaused={feed.setAiPaused} />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="shelves" element={<ShelvesPage />} />
          <Route path="game" element={<GameSetupPage />} />
          <Route path="*" element={<Navigate to="/dashboard" />} />
        </Routes>
      </main>
    </div>
  );
}
