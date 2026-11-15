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
      {cfg.board_enabled && (
        <div className="row wrap">
          <label>
            Vị trí
            <select value={cfg.board_position} onChange={(e) => set({ board_position: e.target.value as SceneConfig["board_position"] })} aria-label="Vị trí bảng vàng">
              <option value="left">Góc dưới bên trái</option>
              <option value="right">Góc dưới bên phải</option>
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
      <div className="row">
        <button className="primary" disabled={busy}>
          Lưu không gian & banner
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </form>
  );
}
