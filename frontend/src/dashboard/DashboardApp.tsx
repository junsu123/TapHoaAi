// Vietnamese operator dashboard (SPEC I). Only features that really work are shown;
// later milestones are labelled as such instead of being faked.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, formatVnd, setCsrf } from "../lib/api";
import { AiSettingsPage, type AiStatus } from "./AiSettingsPage";
import { QuestionCard, VoiceBar } from "./HostDesk";
import { KnowledgePage } from "./KnowledgePage";
import { LogsPage } from "./LogsPage";
import { BOX_FACE_LABEL, PdfFacePicker, type RenderedFaces } from "./PdfFacePicker";
import { ShelfEditor } from "./ShelfEditor";
import { useDashboardFeed, type CommentRecord, type HostItem, type LiveStatus, type Metrics, type SpeechState } from "./useDashboardFeed";

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

const POLICY_ITEMS = [
  "Có người thật trên webcam, nói chuyện và giới thiệu sản phẩm thật trong suốt buổi.",
  "Cảnh chính là webcam (Shop LIVE); game Chibi chỉ là lớp phụ.",
  "Không phát giọng AI; không tuyên bố chữa bệnh hay cam kết hiệu quả.",
  "Giá trên thẻ sản phẩm đã được xác nhận; không bịa khuyến mãi, tồn kho.",
  "Phát qua OBS / LIVE Manager / LIVE Studio theo quyền tài khoản (không quay màn hình bằng điện thoại).",
];

const CAP_LABEL: Record<string, string> = {
  comment: "Bình luận", join: "Người vào", like: "Thả tim", follow: "Theo dõi", share: "Chia sẻ",
  gift: "Quà tặng", viewer_count: "Số người xem",
};

function capText(v: string, isDemo: boolean) {
  if (isDemo) return "Mô phỏng";
  if (v === "available") return "✓ Đã nhận được";
  if (v === "unavailable") return "✗ Không có";
  if (v === "degraded") return "▲ Không ổn định";
  return "… Chưa thấy sự kiện nào";
}

function ConnectPage({ live }: { live: LiveStatus | null }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<boolean[]>(POLICY_ITEMS.map(() => false));
  const [settings, setSettings] = useState<{ sign_api_key: string | null; library_installed: boolean; sign_server: string } | null>(null);
  const [keyInput, setKeyInput] = useState("");
  useEffect(() => {
    api.get<typeof settings>("/settings/live").then(setSettings);
  }, []);
  const allChecked = checks.every(Boolean);
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
        {settings && !settings.library_installed && (
          <p className="error" role="alert">
            Chưa cài thư viện kết nối TikTok. Chạy <code>pip install -e "backend[tiktok]"</code> rồi khởi động lại phần mềm.
          </p>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.post("/live/connect", { url, policy_ack: allChecked }));
          }}
        >
          <input
            aria-label="Link TikTok LIVE"
            placeholder="https://www.tiktok.com/@tên_tài_khoản/live hoặc link vm.tiktok.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="grow"
          />
          <button className="primary" disabled={busy || !url || !allChecked} title={allChecked ? "" : "Hãy đánh dấu đủ danh sách bên dưới"}>
            Kết nối
          </button>
          <button type="button" onClick={() => run(() => api.post("/live/disconnect"))} disabled={busy}>
            Ngắt kết nối
          </button>
        </form>
        <ErrorText err={err} />
        <fieldset className="policy">
          <legend>Xác nhận trước khi LIVE bán hàng (bắt buộc)</legend>
          {POLICY_ITEMS.map((t, i) => (
            <label key={i} className="check">
              <input type="checkbox" checked={checks[i]} onChange={(e) => setChecks(checks.map((c, k) => (k === i ? e.target.checked : c)))} />
              {t}
            </label>
          ))}
          <p className="muted small">Quy định TikTok Shop có thể thay đổi — đối chiếu lại trang chính sách trước mỗi đợt LIVE (docs/policy-checklist-vn.md).</p>
        </fieldset>
        <p className="muted">
          Kết nối qua thư viện TikTokLive (không chính thức): có thể ngừng hoạt động khi TikTok thay đổi. Để kết nối, tên tài khoản LIVE được gửi tới máy chủ ký
          {settings ? ` ${settings.sign_server}` : ""} của bên thứ ba; thông tin người xem không được gửi đi. Hệ thống không vượt CAPTCHA hay chặn truy cập.
        </p>
      </Card>
      <Card title="Trạng thái">
        <StatusPill status={live?.status ?? "Chưa kết nối"} />
        {live?.detail && <p data-testid="live-detail">{live.detail}</p>}
        <dl className="kv">
          <dt>Nguồn</dt>
          <dd>{live?.provider === "tiktok_unofficial" ? "TikTok LIVE (TikTokLive)" : live?.provider === "demo" ? "Demo" : "—"}</dd>
          <dt>Tài khoản</dt>
          <dd>{live?.unique_id ? `@${live.unique_id}` : "—"}</dd>
          <dt>Phòng</dt>
          <dd>{live?.room_id ?? "—"}</dd>
          <dt>Phiên</dt>
          <dd>{live?.session_id ?? "—"}</dd>
        </dl>
        {live && Object.keys(live.capabilities).length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Loại sự kiện</th>
                <th>Thực tế trong phiên này</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(live.capabilities).map(([k, v]) => (
                <tr key={k}>
                  <td>{CAP_LABEL[k] ?? k}</td>
                  <td>{capText(v, live.is_demo)}</td>
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
      <Card title="Chế độ Demo">
        <div className="row">
          <button className="primary" onClick={() => run(() => api.post("/demo/start"))} disabled={busy}>
            Bật Demo
          </button>
          <span className="muted">Dùng cùng đường ống sự kiện với LIVE thật; mọi người xem giả đều có nhãn DEMO.</span>
        </div>
      </Card>
      <Card title="Khóa máy chủ ký Euler Stream (tùy chọn)">
        <p className="muted">
          Bản miễn phí giới hạn số lần kết nối. Nếu hay gặp lỗi “giới hạn lượt”, mua khóa tại eulerstream.com và nhập ở đây. Khóa được mã hóa và không bao giờ hiện lại đầy đủ.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              setSettings(await api.patch("/settings/live", { sign_api_key: keyInput }));
              setKeyInput("");
            });
          }}
        >
          <input type="password" aria-label="Khóa Euler Stream" className="grow" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder={settings?.sign_api_key ?? "Chưa có khóa"} />
          <button>Lưu khóa</button>
          {settings?.sign_api_key && (
            <button type="button" onClick={() => run(async () => setSettings(await api.patch("/settings/live", { sign_api_key: null })))}>
              Xóa khóa
            </button>
          )}
        </form>
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

function HostPage({
  comments,
  host,
  aiPaused,
  setAiPaused,
  speech,
  ai,
}: {
  comments: CommentRecord[];
  host: HostItem[];
  aiPaused: boolean;
  setAiPaused: (b: boolean) => void;
  speech: SpeechState | null;
  ai: AiStatus | null;
}) {
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
        <Card title="Giọng đọc trên LIVE">
          <VoiceBar speech={speech} ai={ai} />
        </Card>
        <Card title="Câu hỏi cần trả lời">
          <div className="row">
            <button onClick={togglePause} aria-pressed={aiPaused}>
              {aiPaused ? "▶ Tiếp tục AI" : "⏸ Tạm dừng AI"}
            </button>
            <span className="muted">Phím tắt Ctrl+Shift+P. Tạm dừng AI không dừng bình luận hay game.</span>
          </div>
          {host.length === 0 && <p className="muted">Chưa có câu hỏi hoặc bình luận mơ hồ.</p>}
          <ul className="host-list">
            {host.map((h) => (
              <QuestionCard key={h.event_id} h={h} />
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
            <button onClick={() => send({ raw: "@thuha: trà cà gai leo giá bao nhiêu vậy shop?" })}>@thuha: hỏi giá</button>
            <button onClick={() => send({ raw: "@namvo: shop có ship COD không" })}>@namvo: hỏi ship</button>
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

type FaceName = "left" | "right" | "back" | "top" | "bottom";
const FACE_LABEL: Record<FaceName, string> = { left: "Mặt bên trái", right: "Mặt bên phải", back: "Mặt sau", top: "Nắp trên", bottom: "Đáy" };
const GAME_BOX_HEIGHT = 0.28; // m — boxes are shown a bit larger than life so viewers can read them

async function uploadImage(file: File): Promise<number> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("kind", "image");
  return (await api.upload<{ id: number }>("/assets/upload", fd)).id;
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
  model_url: string | null;
  face_urls: Partial<Record<FaceName, string>>;
  box_color: string | null;
  card_image_url: string | null;
  box_size: Record<string, number> | null;
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
  const [glb, setGlb] = useState<File | null>(null);
  const [faces, setFaces] = useState<Partial<Record<FaceName, File>>>({});
  const [dropFaces, setDropFaces] = useState<Partial<Record<FaceName, boolean>>>({});
  const [card, setCard] = useState<File | null>(null);
  const [color, setColor] = useState(p?.box_color ?? "#f6f1ea");
  const [cm, setCm] = useState({
    w: String(p?.box_size?.cm_w ?? ""),
    h: String(p?.box_size?.cm_h ?? ""),
    d: String(p?.box_size?.cm_d ?? ""),
  });
  const [dropModel, setDropModel] = useState(false);
  const [pdfFaces, setPdfFaces] = useState<RenderedFaces>({});
  const [picker, setPicker] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      let image_asset_id: number | undefined = pdfFaces.front?.id;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("kind", "image");
        image_asset_id = (await api.upload<{ id: number }>("/assets/upload", fd)).id;
      }
      let model: { model_asset_id?: number | null } = dropModel ? { model_asset_id: null } : {};
      if (glb) {
        const fd = new FormData();
        fd.append("file", glb);
        fd.append("kind", "model");
        model = { model_asset_id: (await api.upload<{ id: number }>("/assets/upload", fd)).id };
      }
      const face_assets: Partial<Record<FaceName, number | null>> = {};
      for (const k of Object.keys(FACE_LABEL) as FaceName[]) {
        if (faces[k]) face_assets[k] = await uploadImage(faces[k]!);
        else if (pdfFaces[k]) face_assets[k] = pdfFaces[k]!.id;
        else if (dropFaces[k]) face_assets[k] = null;
      }
      const extras: Record<string, unknown> = { box_color: color };
      if (Object.keys(face_assets).length) extras.face_assets = face_assets;
      if (card) extras.card_image_asset_id = await uploadImage(card);
      const [cw, ch, cd] = [Number(cm.w), Number(cm.h), Number(cm.d)];
      if (cw > 0 && ch > 0 && cd > 0) {
        // real proportions, shown at a readable game height
        const k = GAME_BOX_HEIGHT / ch;
        extras.box_size = { w: +(cw * k).toFixed(4), h: GAME_BOX_HEIGHT, d: +(cd * k).toFixed(4), cm_w: cw, cm_h: ch, cm_d: cd };
      }
      const body = {
        ...extras,
        sku: f.sku,
        name: f.name,
        price: f.price === "" ? null : Number(f.price),
        status: f.status,
        disclaimer: f.disclaimer || null,
        verify_price: f.verify,
        ...(image_asset_id ? { image_asset_id } : {}),
        ...model,
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
      <label>
        Mô hình 3D GLB (tùy chọn, ≤ 20 MB) — nếu lỗi, game tự dùng hộp ảnh
        <input type="file" accept=".glb,model/gltf-binary" onChange={(e) => setGlb(e.target.files?.[0] ?? null)} />
      </label>
      <fieldset className="faces">
        <legend>Hộp sản phẩm trông thật (tùy chọn)</legend>
        <p className="muted small">
          Dùng ảnh thẳng, đã duyệt của từng mặt hộp (xuất từ file thiết kế in là nét nhất, hoặc tách từ ảnh 3D bằng scripts/unwarp_box.py). Mặt nào không có ảnh sẽ là màu trơn — hệ thống không tự vẽ thêm chữ.
        </p>
        <div className="pdf-cta">
          <button type="button" className="primary" onClick={() => setPicker(true)}>
            📄 Lấy tất cả các mặt từ file in PDF…
          </button>
          <span className="muted small">File thiết kế gửi nhà in (bản trải phẳng của hộp) cho ảnh nét nhất.</span>
        </div>
        {Object.keys(pdfFaces).length > 0 && (
          <div className="pdf-faces" data-testid="pdf-faces-ready">
            {(Object.keys(pdfFaces) as (keyof RenderedFaces)[]).map((k) => (
              <figure key={k}>
                <img src={pdfFaces[k]!.url} alt={BOX_FACE_LABEL[k]} />
                <figcaption>{BOX_FACE_LABEL[k]}</figcaption>
              </figure>
            ))}
            <p className="small">Đã lấy {Object.keys(pdfFaces).length} mặt từ file PDF — bấm <b>Lưu</b> để áp dụng.</p>
          </div>
        )}
        {picker && <PdfFacePicker cm={cm} setCm={setCm} boxColor={color} onApply={setPdfFaces} onClose={() => setPicker(false)} />}
        <div className="row wrap">
          <label>
            Kích thước thật (cm): rộng
            <input type="number" min={1} step={0.1} value={cm.w} onChange={(e) => setCm({ ...cm, w: e.target.value })} style={{ width: 90 }} />
          </label>
          <label>
            cao
            <input type="number" min={1} step={0.1} value={cm.h} onChange={(e) => setCm({ ...cm, h: e.target.value })} style={{ width: 90 }} />
          </label>
          <label>
            dày
            <input type="number" min={0.5} step={0.1} value={cm.d} onChange={(e) => setCm({ ...cm, d: e.target.value })} style={{ width: 90 }} />
          </label>
          <label>
            Màu các mặt chưa có ảnh
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 70, padding: 2 }} />
          </label>
        </div>
        {(Object.keys(FACE_LABEL) as FaceName[]).map((k) => (
          <div key={k} className="row wrap">
            <label className="grow">
              {FACE_LABEL[k]}
              {p?.face_urls?.[k] ? " (đã có ảnh)" : ""}
              <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={FACE_LABEL[k]} onChange={(e) => setFaces({ ...faces, [k]: e.target.files?.[0] })} />
            </label>
            {p?.face_urls?.[k] && (
              <label className="check">
                <input type="checkbox" checked={!!dropFaces[k]} onChange={(e) => setDropFaces({ ...dropFaces, [k]: e.target.checked })} /> Gỡ
              </label>
            )}
          </div>
        ))}
        <label>
          Ảnh hiện trên thẻ sản phẩm khi LIVE (ví dụ ảnh 3D/ảnh chụp đẹp){p?.card_image_url ? " — đã có" : ""}
          <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Ảnh thẻ sản phẩm" onChange={(e) => setCard(e.target.files?.[0] ?? null)} />
        </label>
      </fieldset>
      {p?.model_url && (
        <label className="check">
          <input type="checkbox" checked={dropModel} onChange={(e) => setDropModel(e.target.checked)} /> Gỡ mô hình GLB hiện tại
        </label>
      )}
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
              <th>3D</th>
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
                <td>{p.model_url ? "GLB" : "Hộp ảnh"}</td>
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
    <div className="stack">
    <Card title="Sơ đồ cửa hàng">
      <ShelfEditor onChanged={load} />
    </Card>
    <Card title="Gắn sản phẩm vào kệ">
      <p className="muted">Gắn mỗi sản phẩm vào một ô kệ. Thay đổi có hiệu lực ngay với bình luận mới.</p>
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
    </div>
  );
}

function LeaveSetting() {
  const [minutes, setMinutes] = useState<string>("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ idle_exit_minutes: number; note: string }>("/settings/game").then((r) => {
      setMinutes(String(r.idle_exit_minutes));
      setNote(r.note);
    });
  }, []);
  return (
    <form
      className="row wrap"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg(null);
        try {
          const r = await api.patch<{ idle_exit_minutes: number }>("/settings/game", { idle_exit_minutes: Number(minutes) });
          setMinutes(String(r.idle_exit_minutes));
          setMsg("Đã lưu.");
        } catch (x) {
          setMsg(x instanceof ApiError ? x.message : String(x));
        }
      }}
    >
      <label>
        Chibi rời cửa hàng sau (phút không tương tác)
        <input type="number" min={1} max={60} step={0.5} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 120 }} />
      </label>
      <button className="primary">Lưu</button>
      {msg && <span className="muted">{msg}</span>}
      <p className="muted small">{note}</p>
    </form>
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
        <Card title="Khi người xem rời LIVE">
          <LeaveSetting />
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

function SettingsPage() {
  const [items, setItems] = useState<{ name: string; size_bytes: number; created_at: string }[]>([]);
  const [hint, setHint] = useState<{ restore_hint: string; secret_key_note: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.get<{ items: typeof items; restore_hint: string; secret_key_note: string }>("/backups").then((r) => {
      setItems(r.items);
      setHint(r);
    });
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="stack">
      <Card title="Sao lưu">
        <div className="row">
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setErr(null);
              setBusy(true);
              try {
                await api.post("/backups");
                await load();
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : String(x));
              } finally {
                setBusy(false);
              }
            }}
          >
            Sao lưu ngay
          </button>
          <span className="muted">Gồm cơ sở dữ liệu và ảnh/mô hình sản phẩm.</span>
        </div>
        <ErrorText err={err} />
        <table>
          <thead>
            <tr>
              <th>Bản sao lưu</th>
              <th>Thời gian</th>
              <th>Dung lượng</th>
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.name} data-testid="backup-row">
                <td>
                  <a href={`/api/v1/backups/${b.name}`} download>
                    {b.name}
                  </a>
                </td>
                <td>{new Date(b.created_at).toLocaleString("vi-VN")}</td>
                <td>{(b.size_bytes / 1024).toFixed(0)} KB</td>
              </tr>
            ))}
          </tbody>
        </table>
        {hint && (
          <>
            <p className="muted">Khôi phục: {hint.restore_hint}</p>
            <p className="muted">{hint.secret_key_note}</p>
          </>
        )}
      </Card>
      <Card title="Xuất cấu hình">
        <div className="row wrap">
          <a className="button-link" href="/api/v1/config/export" download="cau-hinh.json">
            Tải cấu hình (JSON)
          </a>
          <a className="button-link" href="/api/v1/config/products.csv" download>
            Tải danh sách sản phẩm (CSV, mở bằng Excel)
          </a>
        </div>
        <p className="muted">Không chứa mật khẩu, khóa API hay ảnh.</p>
      </Card>
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
    ["ai", "Trợ lý AI & giọng đọc"],
    ["knowledge", "Hội thoại & câu đã học"],
    ["products", "Sản phẩm"],
    ["shelves", "Bản đồ kệ"],
    ["game", "Game 3D & OBS"],
    ["settings", "Cài đặt & sao lưu"],
    ["logs", "Nhật ký lỗi"],
  ];
  return (
    <div className="dash">
      <aside>
        <div className="brand">Chibi Live Shop</div>
        <nav>
          {nav.map(([to, label]) => (
            <NavLink key={to} to={`/dashboard/${to}`} end={to === ""}>
              {label}
              {to === "logs" && feed.logStats && feed.logStats.unseen > 0 && (
                <span className="nav-badge" data-testid="log-badge">
                  {feed.logStats.unseen > 99 ? "99+" : feed.logStats.unseen}
                </span>
              )}
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
        {feed.alerts.slice(0, 1).map((a) => (
          <div className="banner" key={a.at} data-testid="ai-alert">
            ⚠ {a.message}
          </div>
        ))}
        <Routes>
          <Route index element={<Overview live={feed.live} metrics={feed.metrics} />} />
          <Route path="connect" element={<ConnectPage live={feed.live} />} />
          <Route path="host" element={<HostPage comments={feed.comments} host={feed.host} aiPaused={feed.aiPaused} setAiPaused={feed.setAiPaused} speech={feed.speech} ai={feed.ai} />} />
          <Route path="ai" element={<AiSettingsPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="logs" element={<LogsPage live={feed.liveLogs} stats={feed.logStats} onSeen={feed.setLogStats} />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="shelves" element={<ShelvesPage />} />
          <Route path="game" element={<GameSetupPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" />} />
        </Routes>
      </main>
    </div>
  );
}
