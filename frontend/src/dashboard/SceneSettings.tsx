// Shop look (herbal-tea / pink Chibi) and the big product banner on the LIVE frame.

import { useEffect, useState } from "react";
import { api, ApiError, formatVnd } from "../lib/api";
import type { SceneConfig } from "../types/protocol";

interface ProductLite {
  id: string;
  name: string;
  price: number | null;
  image_url: string | null;
  card_image_url: string | null;
}

export function SceneSettings() {
  const [cfg, setCfg] = useState<SceneConfig | null>(null);
  const [themes, setThemes] = useState<Record<string, string>>({});
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ config: SceneConfig; themes: Record<string, string> }>("/settings/scene").then((r) => {
      setCfg(r.config);
      setThemes(r.themes);
    });
    api.get<ProductLite[]>("/products").then(setProducts);
  }, []);
  if (!cfg) return <p className="muted">Đang tải…</p>;
  const set = (patch: Partial<SceneConfig>) => setCfg({ ...cfg, ...patch });
  const withPhoto = products.filter((p) => p.card_image_url || p.image_url);
  const chosen = new Set(cfg.banner_product_ids);
  const toggle = (id: string) =>
    set({ banner_product_ids: chosen.has(id) ? cfg.banner_product_ids.filter((x) => x !== id) : [...cfg.banner_product_ids, id] });
  return (
    <form
      className="stack scene-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg(null);
        setBusy(true);
        try {
          const r = await api.put<{ config: SceneConfig }>("/settings/scene", cfg);
          setCfg(r.config);
          setMsg("Đã lưu — màn hình LIVE đổi ngay.");
        } catch (x) {
          setMsg(x instanceof ApiError ? x.message : String(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Kiểu cửa hàng
        <select value={cfg.theme} onChange={(e) => set({ theme: e.target.value as SceneConfig["theme"] })}>
          {Object.entries(themes).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Chữ trên biển hiệu
        <input value={cfg.sign_text} maxLength={32} onChange={(e) => set({ sign_text: e.target.value })} />
      </label>
      <label>
        Dòng phụ dưới biển hiệu
        <input value={cfg.tagline} maxLength={48} onChange={(e) => set({ tagline: e.target.value })} placeholder="VD: Trà sạch · Thảo mộc Việt" />
      </label>

      <h3>Banner ảnh sản phẩm</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.banner_enabled} onChange={(e) => set({ banner_enabled: e.target.checked })} />
        Hiện ảnh sản phẩm (màn hình LED trên tường, hoặc khung phía trên màn hình LIVE)
      </label>
      <label>
        Kiểu khung
        <select value={cfg.banner_style} onChange={(e) => set({ banner_style: e.target.value as SceneConfig["banner_style"] })} aria-label="Kiểu khung banner">
          <option value="led">Màn hình LED gắn trên tường quán</option>
          <option value="tv">Tivi phủ phía trên màn hình LIVE</option>
          <option value="board">Bảng gỗ phủ phía trên màn hình LIVE</option>
        </select>
      </label>
      <fieldset className="banner-mode">
        <legend>Cách chạy</legend>
        <label className="check">
          <input type="radio" name="banner_mode" checked={cfg.banner_mode === "scroll"} onChange={() => set({ banner_mode: "scroll" })} />
          Chạy liên tục — ảnh sản phẩm trượt ngang không ngừng như băng chuyền
        </label>
        <label className="check">
          <input type="radio" name="banner_mode" checked={cfg.banner_mode === "slide"} onChange={() => set({ banner_mode: "slide" })} />
          Lần lượt — mỗi lần một sản phẩm thật to, đổi sau vài giây
        </label>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={cfg.banner_focus_on_show} onChange={(e) => set({ banner_focus_on_show: e.target.checked })} />
        Khi Chibi cầm sản phẩm ra cho khách xem: banner dừng lại, chỉ hiện sản phẩm đó (tắt = banner vẫn chạy, sản phẩm đó được viền đỏ)
      </label>
      {cfg.banner_style !== "led" && (
      <label>
          <span>
            Chiều cao banner: <b>{Math.round(cfg.banner_height * 100)}%</b> màn hình
          </span>
          <input type="range" min={0.15} max={0.4} step={0.01} value={cfg.banner_height} onChange={(e) => set({ banner_height: Number(e.target.value) })} aria-label="Chiều cao banner" />
        </label>
      )}
      <label>
        <span>
          {cfg.banner_mode === "scroll" ? "Tốc độ: mỗi sản phẩm trượt qua trong " : "Đổi sản phẩm sau: "}
          <b>{cfg.banner_seconds} giây</b>
          {cfg.banner_mode === "scroll" ? " (ít giây hơn = chạy nhanh hơn)" : ""}
        </span>
        <input type="range" min={2} max={30} step={1} value={cfg.banner_seconds} onChange={(e) => set({ banner_seconds: Number(e.target.value) })} aria-label="Thời gian mỗi sản phẩm" />
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.banner_show_price} onChange={(e) => set({ banner_show_price: e.target.checked })} />
        Hiện giá (chỉ giá đã xác nhận)
      </label>
      <div>
        <div className="small">Sản phẩm trên banner {cfg.banner_product_ids.length ? `(${cfg.banner_product_ids.length} đã chọn, theo thứ tự bấm)` : "(chưa chọn → hiện tất cả sản phẩm có ảnh)"}</div>
        {withPhoto.length === 0 && <p className="muted small">Chưa có sản phẩm nào có ảnh — thêm ảnh ở mục Sản phẩm.</p>}
        <div className="banner-pick">
          {withPhoto.map((p) => {
            const n = cfg.banner_product_ids.indexOf(p.id);
            return (
              <button type="button" key={p.id} className={`banner-pick-item${n >= 0 ? " on" : ""}`} onClick={() => toggle(p.id)} aria-pressed={n >= 0} title={p.name}>
                <img src={p.card_image_url || p.image_url!} alt="" />
                <span>{p.name}</span>
                <span className="muted">{formatVnd(p.price) ?? "chưa có giá"}</span>
                {n >= 0 && <b className="banner-pick-n">{n + 1}</b>}
              </button>
            );
          })}
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={cfg.wall_posters} onChange={(e) => set({ wall_posters: e.target.checked })} />
        Treo ảnh sản phẩm trong khung trên tường cửa hàng 3D
      </label>

      <h3>Chibi chủ quán</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.owner_enabled} onChange={(e) => set({ owner_enabled: e.target.checked })} aria-label="Chibi chủ quán" />
        Có Chibi chủ quán ngồi pha trà ở bàn trà giữa quán
      </label>
      <p className="muted small">
        Có người vào LIVE: chủ quán đứng dậy cúi chào, hiện bong bóng lời chào (nhiều người vào cùng lúc thì gộp tên). Có người tặng quà: Chibi của khách tới ngồi đối diện, chủ quán rót trà mời. Ghi đơn mua hàng: chủ quán cảm ơn.
      </p>
      <label className="check">
        <input type="checkbox" checked={cfg.chat_on_screen} onChange={(e) => set({ chat_on_screen: e.target.checked })} aria-label="Hiện chữ bình luận trên màn hình" />
        Hiện chữ bình luận của khách (và câu chủ quán trả lời) trên màn hình — tắt: chỉ đọc bằng giọng, không hiện bong bóng hay dòng chữ
      </label>
      {cfg.owner_enabled && (
        <>
          <label>
            Tên trên đầu chủ quán
            <input value={cfg.owner_name} maxLength={24} onChange={(e) => set({ owner_name: e.target.value })} aria-label="Tên chủ quán" />
          </label>
          <label>
            Lời chào khách vào ({"{ten}"} = tên khách)
            <input value={cfg.owner_greet_template} maxLength={120} onChange={(e) => set({ owner_greet_template: e.target.value })} aria-label="Lời chào của chủ quán" />
          </label>
          <label>
            Lời mời trà khách tặng quà ({"{ten}"}, {"{qua}"} = quà)
            <input value={cfg.owner_tea_template} maxLength={140} onChange={(e) => set({ owner_tea_template: e.target.value })} aria-label="Lời mời trà" />
          </label>
          <label>
            Lời cảm ơn khách mua ({"{ten}"}, {"{san_pham}"})
            <input value={cfg.owner_buy_template} maxLength={120} onChange={(e) => set({ owner_buy_template: e.target.value })} aria-label="Lời cảm ơn khách mua" />
          </label>
        </>
      )}

      <h3>Bảng vàng</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.board_enabled} onChange={(e) => set({ board_enabled: e.target.checked })} aria-label="Bảng vàng" />
        Hiện bảng vàng top tặng quà & mua hàng trên màn hình LIVE
      </label>
      {cfg.board_enabled && <BoardPlacer cfg={cfg} onSaved={(c) => setCfg((prev) => (prev ? { ...prev, board_x: c.board_x, board_y: c.board_y, board_scale: c.board_scale } : prev))} />}
      {cfg.board_enabled && (
        <div className="row wrap">
          <label>
            Góc mặc định
            <select value={cfg.board_position} onChange={(e) => set({ board_position: e.target.value as SceneConfig["board_position"] })} aria-label="Vị trí bảng vàng">
              <option value="left">Dưới bên trái</option>
              <option value="right">Dưới bên phải</option>
            </select>
          </label>
          <label>
            Số người mỗi bảng
            <select value={cfg.board_size} onChange={(e) => set({ board_size: Number(e.target.value) })} aria-label="Số người mỗi bảng">
              {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  Top {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tính từ
            <select value={cfg.board_scope} onChange={(e) => set({ board_scope: e.target.value as SceneConfig["board_scope"] })} aria-label="Phạm vi bảng vàng">
              <option value="session">Từng buổi LIVE (tự làm mới)</option>
              <option value="all">Mọi buổi LIVE (tới khi làm mới)</option>
            </select>
          </label>
        </div>
      )}
      <h3>Sân khấu</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.stage_enabled} onChange={(e) => set({ stage_enabled: e.target.checked })} aria-label="Sân khấu" />
        Có sân khấu: khách bình luận “nhảy” / “lên sân khấu” được xếp hàng, ai bình luận trước lên nhảy trước
      </label>
      {cfg.stage_enabled && (
        <div className="row wrap">
          <label>
            Mỗi lượt nhảy
            <select value={cfg.stage_seconds} onChange={(e) => set({ stage_seconds: Number(e.target.value) })} aria-label="Thời gian mỗi lượt nhảy">
              {[8, 10, 15, 20, 30, 45, 60].map((n) => (
                <option key={n} value={n}>
                  {n} giây
                </option>
              ))}
            </select>
          </label>
          <label>
            Hàng chờ tối đa
            <select value={cfg.stage_max_queue} onChange={(e) => set({ stage_max_queue: Number(e.target.value) })} aria-label="Hàng chờ sân khấu tối đa">
              {[5, 10, 20, 30, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} người
                </option>
              ))}
            </select>
          </label>
          <label>
            Đặt sân khấu
            <select value={cfg.stage_side} onChange={(e) => set({ stage_side: e.target.value as SceneConfig["stage_side"] })} aria-label="Vị trí sân khấu">
              <option value="right">Phía trước, bên phải</option>
              <option value="left">Phía trước, bên trái</option>
            </select>
          </label>
        </div>
      )}
      <ChibiBehaviorFields cfg={cfg} set={set} />
      <div className="row">
        <button className="primary" disabled={busy}>
          Lưu không gian & banner
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </form>
  );
}

/** Drag the honour board on a live preview of the LIVE screen; dropping it saves the spot. */
function BoardPlacer({ cfg, onSaved }: { cfg: SceneConfig; onSaved: (c: SceneConfig) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const save = async (patch: Partial<SceneConfig>) => {
    try {
      const cur = await api.get<{ config: SceneConfig }>("/settings/scene");
      const r = await api.put<{ config: SceneConfig }>("/settings/scene", { ...cur.config, ...patch });
      onSaved(r.config);
      setNote(
        r.config.board_x == null
          ? "Đã đưa bảng vàng về góc mặc định."
          : `Đã lưu vị trí bảng vàng (cỡ ${Math.round(r.config.board_scale * 100)}%). Màn hình LIVE đổi ngay.`,
      );
    } catch (x) {
      setNote(x instanceof ApiError ? x.message : String(x));
    }
  };
  useEffect(() => {
    if (!open) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== "chibi-board") return;
      const { x, y, scale } = e.data as { x: number; y: number; scale: number };
      save({ board_x: x, board_y: y, board_scale: scale });
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="board-placer">
      <div className="row wrap">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Xong, đóng khung kéo thả" : "Kéo thả bảng vàng tới chỗ muốn đặt"}
        </button>
        {(cfg.board_x != null || cfg.board_scale !== 1) && (
          <button type="button" onClick={() => save({ board_x: null, board_y: null, board_scale: 1 })}>
            Về góc mặc định
          </button>
        )}
        {note && (
          <span className="muted small" data-testid="board-place-note">
            {note}
          </span>
        )}
      </div>
      {open && (
        <div className="board-placer-frame">
          <iframe title="Kéo thả bảng vàng" src="/game/live?role=viewer&quality=low&edit=board" data-testid="board-placer-frame" />
          <p className="muted small">Kéo bảng vàng trong khung này. Kéo chấm vàng ở góc để phóng to, thu nhỏ. Thả tay là lưu.</p>
        </div>
      )}
    </div>
  );
}

const GROUPS: { key: keyof SceneConfig; label: string; hint: string }[] = [
  { key: "chibi_w_browse", label: "Xem kệ, xem giá", hint: "đứng trước kệ ngắm hàng" },
  { key: "chibi_w_explore", label: "Dạo quanh", hint: "đi lại trong quán, đọc biển" },
  { key: "chibi_w_idle", label: "Đứng nghỉ", hint: "thở, nhìn quanh, vươn vai" },
  { key: "chibi_w_social", label: "Chào nhau", hint: "vẫy tay, gật đầu với Chibi bên cạnh" },
  { key: "chibi_w_rest", label: "Ngồi ghế", hint: "ngồi ghế dài, uống trà, ngáp" },
  { key: "chibi_w_fun", label: "Vui nhộn", hint: "nhảy, tạo dáng, xoay vòng, vỗ tay" },
];
const DEFAULT_WEIGHTS = { chibi_w_browse: 30, chibi_w_explore: 25, chibi_w_idle: 20, chibi_w_social: 10, chibi_w_rest: 10, chibi_w_fun: 5 };

/** How Chibis spend their time when nobody gives them a command (spec V3 §5, §11). */
function ChibiBehaviorFields({ cfg, set }: { cfg: SceneConfig; set: (p: Partial<SceneConfig>) => void }) {
  const total = GROUPS.reduce((n, g) => n + Number(cfg[g.key] ?? 0), 0);
  return (
    <>
      <h3>Hành vi Chibi</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.chibi_autonomous} onChange={(e) => set({ chibi_autonomous: e.target.checked })} aria-label="Chibi tự sinh hoạt" />
        Chibi tự sinh hoạt khi không có lệnh (tắt thì Chibi đứng yên chờ bình luận)
      </label>
      {cfg.chibi_autonomous && (
        <div className="chibi-weights" data-testid="chibi-weights">
          <p className="muted small">Kéo để chọn Chibi hay làm việc gì hơn. Phần trăm là tỉ lệ thời gian dự kiến.</p>
          {GROUPS.map((g) => {
            const v = Number(cfg[g.key] ?? 0);
            return (
              <label key={g.key} className="weight-row">
                <span className="weight-name">
                  {g.label}
                  <small className="muted">{g.hint}</small>
                </span>
                <input type="range" min={0} max={60} step={1} value={v} aria-label={g.label} onChange={(e) => set({ [g.key]: Number(e.target.value) } as Partial<SceneConfig>)} />
                <span className="weight-pct">{total > 0 ? Math.round((v / total) * 100) : 0}%</span>
              </label>
            );
          })}
          <button type="button" onClick={() => set(DEFAULT_WEIGHTS)}>
            Về tỉ lệ mặc định
          </button>
        </div>
      )}
      <label>
        Số Chibi tối đa trên màn hình
        <input
          type="number"
          min={10}
          max={80}
          value={cfg.chibi_max_visible}
          onChange={(e) => set({ chibi_max_visible: Number(e.target.value) })}
          aria-label="Số Chibi tối đa"
          style={{ width: 110 }}
        />
        <small className="muted">Đông hơn thì người mới chờ ngoài cửa và vào khi có Chibi ra về. Máy yếu nên để 30–40.</small>
      </label>
    </>
  );
}
