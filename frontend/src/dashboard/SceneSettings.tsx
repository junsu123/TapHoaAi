// Shop look (herbal-tea / pink Chibi) and the LED product screen on the shop's back wall.

import { useEffect, useState } from "react";
import { api, ApiError, formatVnd } from "../lib/api";
import type { AgendaItem, QuizQuestion, SceneConfig } from "../types/protocol";
import { isMoved, OVERLAY_ITEMS, overlayItem, placePatch, spotOf, type OverlayKey } from "../game/overlayItems";

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

      <h3>Màn hình LED sản phẩm</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.banner_enabled} onChange={(e) => set({ banner_enabled: e.target.checked })} aria-label="Màn hình LED sản phẩm" />
        Hiện ảnh sản phẩm trên màn hình LED gắn cố định trên tường quán (nằm trong quán 3D: Chibi đi phía trước, không che hình LIVE)
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
        Khi Chibi cầm sản phẩm ra cho khách xem: màn LED dừng lại, chỉ hiện sản phẩm đó (tắt = màn LED vẫn chạy)
      </label>
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
        <div className="small">Sản phẩm trên màn LED {cfg.banner_product_ids.length ? `(${cfg.banner_product_ids.length} đã chọn, theo thứ tự bấm)` : "(chưa chọn → hiện tất cả sản phẩm có ảnh)"}</div>
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

      <h3>Bố cục màn hình LIVE</h3>
      <LayoutPlacer
        cfg={cfg}
        onPatch={(p) => setCfg((prev) => (prev ? { ...prev, ...p } : prev))}
        onSaved={(c) => setCfg((prev) => (prev ? { ...prev, ...overlayFields(c) } : prev))}
      />
      <h3>Bảng vàng</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.board_enabled} onChange={(e) => set({ board_enabled: e.target.checked })} aria-label="Bảng vàng" />
        Hiện bảng vàng top tặng quà & mua hàng trên màn hình LIVE
      </label>
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
              <option value="center">Giữa quán (ai cũng thấy người nhảy)</option>
              <option value="right">Phía trước, bên phải</option>
              <option value="left">Phía trước, bên trái</option>
            </select>
          </label>
        </div>
      )}
      <h3>Bảng “Sắp diễn ra”</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.upcoming_enabled} onChange={(e) => set({ upcoming_enabled: e.target.checked })} aria-label="Bảng sắp diễn ra" />
        Hiện trên LIVE những gì sắp tới, có đếm ngược: bài thơ tiếp theo, ai sắp lên cấp, hàng chờ sân khấu, lịch của shop — để người xem chờ thêm chút nữa
      </label>
      {cfg.upcoming_enabled && <AgendaEditor items={cfg.agenda} onChange={(agenda) => set({ agenda })} />}
      <h3>Mini-game</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.minigame_enabled} onChange={(e) => set({ minigame_enabled: e.target.checked })} aria-label="Mini-game tự động" />
        <span>
          Tự chạy một mini-game ngắn, cứ khoảng
          <input
            type="number"
            className="mini"
            min={3}
            max={120}
            value={cfg.minigame_every_min}
            disabled={!cfg.minigame_enabled}
            onChange={(e) => set({ minigame_every_min: Math.max(3, Math.min(120, Number(e.target.value) || 3)) })}
            aria-label="Mini-game sau ít nhất (phút)"
          />
          đến
          <input
            type="number"
            className="mini"
            min={3}
            max={120}
            value={cfg.minigame_every_max}
            disabled={!cfg.minigame_enabled}
            onChange={(e) => set({ minigame_every_max: Math.max(3, Math.min(120, Number(e.target.value) || 3)) })}
            aria-label="Mini-game sau nhiều nhất (phút)"
          />
          phút một lần. Người thắng được đeo huy chương trên Chibi và lên Bảng vàng (tab Mini-game).
        </span>
      </label>
      <div className="row wrap">
        {(
          [
            ["price", "Đoán giá (sản phẩm có giá đã kiểm tra)"],
            ["quiz", "Đố vui (A / B / C)"],
            ["keyword", "Nhanh tay (gõ đúng chữ)"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={cfg.minigame_kinds.includes(k)}
              onChange={(e) =>
                set({ minigame_kinds: e.target.checked ? [...cfg.minigame_kinds.filter((x) => x !== k), k] : cfg.minigame_kinds.filter((x) => x !== k) })
              }
              aria-label={label}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="row wrap">
        <label>
          Thời gian trả lời
          <select value={cfg.minigame_seconds} onChange={(e) => set({ minigame_seconds: Number(e.target.value) })} aria-label="Thời gian trả lời mini-game">
            {[20, 30, 45, 60, 90].map((n) => (
              <option key={n} value={n}>
                {n} giây
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={cfg.minigame_voice} onChange={(e) => set({ minigame_voice: e.target.checked })} aria-label="Chủ quán đọc mini-game" />
          Chủ quán đọc câu hỏi và kết quả bằng giọng
        </label>
      </div>
      <QuizEditor items={cfg.minigame_questions} onChange={(minigame_questions) => set({ minigame_questions })} />
      <p className="muted small">
        Phần thưởng chỉ là danh hiệu trong game (huy chương, Bảng vàng). Nếu tặng quà thật hay rút thăm, shop cần làm đúng quy định khuyến mãi của TikTok.
      </p>
      <h3>Chibi lên cấp theo thời gian xem</h3>
      <label className="check">
        <input type="checkbox" checked={cfg.levels_enabled} onChange={(e) => set({ levels_enabled: e.target.checked })} aria-label="Chibi lên cấp" />
        Người xem ở lại càng lâu, Chibi càng “xịn”: nón lá → áo choàng → vương miện, có số cấp cạnh tên và vạch tiến độ khi sắp lên cấp
      </label>
      {cfg.levels_enabled && (
        <>
          <div className="row wrap">
            {(["Nón lá", "Áo choàng", "Vương miện"] as const).map((item, i) => (
              <label key={item}>
                {item} sau
                <input
                  type="number"
                  className="mini"
                  min={1}
                  max={240}
                  value={cfg.level_minutes[i]}
                  onChange={(e) => {
                    const m = [...cfg.level_minutes];
                    m[i] = Math.max(1, Math.min(240, Number(e.target.value) || 1));
                    set({ level_minutes: m });
                  }}
                  aria-label={`Phút để được ${item.toLowerCase()}`}
                />
                phút
              </label>
            ))}
          </div>
          <label>
            Người xem im lặng vẫn được tính thêm
            <select value={cfg.level_presence_min} onChange={(e) => set({ level_presence_min: Number(e.target.value) })} aria-label="Thời gian tính khi im lặng">
              {[5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n} phút
                </option>
              ))}
            </select>
            <span className="muted small"> sau lần thả tim / bình luận / tặng quà gần nhất (TikTok không báo khi ai rời LIVE)</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.level_voice} onChange={(e) => set({ level_voice: e.target.checked })} aria-label="Chủ quán chúc mừng lên cấp" />
            Chủ quán đọc lời chúc mừng khi lên cấp, và nhắc “còn khoảng 1 phút nữa…” để khách ở lại
          </label>
        </>
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

/** the settings of every box on the LIVE screen: shown or not, where, how big */
function overlayFields(c: SceneConfig): Partial<SceneConfig> {
  const out: Record<string, unknown> = {};
  for (const it of OVERLAY_ITEMS) {
    out[it.show] = c[it.show];
    if (it.place) for (const k of [it.place.x, it.place.y, it.place.scale]) out[k] = c[k];
  }
  return out as Partial<SceneConfig>;
}

/** Every box on the LIVE screen: switch each one on or off, drag them on a live preview of the
 * LIVE screen (dropping one saves its spot), or send one back to its default spot. Saved at once. */
function LayoutPlacer({ cfg, onPatch, onSaved }: { cfg: SceneConfig; onPatch: (p: Partial<SceneConfig>) => void; onSaved: (c: SceneConfig) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const save = async (patch: Partial<SceneConfig>, done: (c: SceneConfig) => string) => {
    try {
      const cur = await api.get<{ config: SceneConfig }>("/settings/scene");
      const r = await api.put<{ config: SceneConfig }>("/settings/scene", { ...cur.config, ...patch });
      onSaved(r.config);
      setNote(done(r.config));
    } catch (x) {
      setNote(x instanceof ApiError ? x.message : String(x));
    }
  };
  useEffect(() => {
    if (!open) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const { type, item, x, y, scale } = (e.data ?? {}) as { type?: string; item?: OverlayKey; x: number; y: number; scale: number };
      if (type !== "chibi-overlay" || !item || !OVERLAY_ITEMS.some((i) => i.key === item && i.place)) return;
      const it = overlayItem(item);
      save(placePatch(item, x, y, scale), (c) => `Đã lưu vị trí ${it.name} (cỡ ${Math.round(spotOf(c, item).scale * 100)}%). Màn hình LIVE đổi ngay.`);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="board-placer">
      <p className="muted small">Bật / tắt từng ô trên màn hình LIVE (lưu ngay), rồi bấm “Kéo thả…” để đặt chúng ở chỗ khác và đổi cỡ.</p>
      <div className="row wrap">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Xong, đóng khung kéo thả" : "Kéo thả các ô trên màn hình LIVE"}
        </button>
        {OVERLAY_ITEMS.some((it) => it.place && isMoved(cfg, it.key)) && (
          <button
            type="button"
            onClick={() =>
              save(Object.assign({}, ...OVERLAY_ITEMS.filter((it) => it.place).map((it) => placePatch(it.key, null, null, 1))), () => "Đã đưa mọi ô về chỗ mặc định.")
            }
          >
            Đưa tất cả về chỗ mặc định
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
          <iframe title="Kéo thả các ô trên màn hình LIVE" src="/game/live?role=viewer&quality=low&edit=board" data-testid="board-placer-frame" />
          <p className="muted small">
            Kéo từng ô (viền chấm) trong khung này. Kéo chấm tròn ở góc để phóng to, thu nhỏ. Thả tay là lưu. Ô nào chưa có nội dung thì hiện bản mẫu để đặt chỗ.
          </p>
        </div>
      )}
      <ul className="overlay-list" data-testid="overlay-list">
        {OVERLAY_ITEMS.map((it) => {
          const on = cfg[it.show] as boolean;
          const moved = it.place && isMoved(cfg, it.key);
          return (
            <li key={it.key} className={on ? "" : "off"} data-testid={`overlay-item-${it.key}`}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const v = e.target.checked;
                    onPatch({ [it.show]: v } as Partial<SceneConfig>); // ticks at once; saved just after
                    save({ [it.show]: v } as Partial<SceneConfig>, () => `Đã ${v ? "bật" : "tắt"} ${it.name}. Màn hình LIVE đổi ngay.`);
                  }}
                  aria-label={`Hiện ${it.label.toLowerCase()}`}
                />
                <span>
                  <b>{it.label}</b>
                  <span className="muted small"> — {it.hint}</span>
                </span>
              </label>
              {moved && (
                <button
                  type="button"
                  className="small"
                  onClick={() => save(placePatch(it.key, null, null, 1), () => `Đã đưa ${it.name} về ${it.key === "board" ? "góc" : "chỗ"} mặc định.`)}
                >
                  {it.label} về {it.key === "board" ? "góc" : "chỗ"} mặc định
                </button>
              )}
            </li>
          );
        })}
      </ul>
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

/** The shop's LIVE schedule: "22:10 Mini-game đoán giá" (shown when it is less than 90 minutes away). */
function AgendaEditor({ items, onChange }: { items: AgendaItem[]; onChange: (v: AgendaItem[]) => void }) {
  const setAt = (i: number, patch: Partial<AgendaItem>) => onChange(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));
  return (
    <div className="agenda-editor" data-testid="agenda-editor">
      <p className="muted small">Lịch LIVE của shop (hiện trên bảng khi còn dưới 90 phút; qua giờ thì tự ẩn). Ví dụ: 22:10 Mini-game đoán giá · 22:30 Giảm giá giờ vàng.</p>
      {items.map((it, i) => (
        <div className="row" key={i}>
          <input type="time" value={it.time} onChange={(e) => setAt(i, { time: e.target.value })} aria-label={`Giờ mục ${i + 1}`} />
          <input
            type="text"
            value={it.text}
            maxLength={60}
            placeholder="Việc gì (vd: Mini-game đoán giá)"
            onChange={(e) => setAt(i, { text: e.target.value })}
            aria-label={`Nội dung mục ${i + 1}`}
          />
          <button type="button" className="link" onClick={() => onChange(items.filter((_, k) => k !== i))} aria-label={`Xóa mục ${i + 1}`}>
            Xóa
          </button>
        </div>
      ))}
      {items.length < 12 && (
        <button type="button" onClick={() => onChange([...items, { time: nextHalfHour(), text: "" }])}>
          + Thêm mục vào lịch
        </button>
      )}
    </div>
  );
}

function nextHalfHour(): string {
  const d = new Date(Date.now() + 30 * 60000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Đố vui" questions of the shop's own: the question, the right answer, two wrong ones. */
function QuizEditor({ items, onChange }: { items: QuizQuestion[]; onChange: (v: QuizQuestion[]) => void }) {
  const setAt = (i: number, q: QuizQuestion) => onChange(items.map((it, k) => (k === i ? q : it)));
  return (
    <div className="quiz-editor" data-testid="quiz-editor">
      <p className="muted small">
        Câu đố của shop (thêm vào các câu có sẵn về trà, Việt Nam và LIVE này). Ô đầu là đáp án đúng; khi chơi, thứ tự A/B/C được xáo ngẫu nhiên. Đừng hỏi về
        công dụng chữa bệnh.
      </p>
      {items.map((q, i) => (
        <div className="quiz-row" key={i}>
          <input
            type="text"
            value={q.question}
            maxLength={140}
            placeholder="Câu hỏi"
            onChange={(e) => setAt(i, { ...q, question: e.target.value })}
            aria-label={`Câu đố ${i + 1}`}
          />
          {q.options.map((o, k) => (
            <input
              key={k}
              type="text"
              value={o}
              maxLength={60}
              placeholder={k === 0 ? "Đáp án đúng" : "Đáp án sai"}
              className={k === 0 ? "right" : ""}
              onChange={(e) => {
                const opts = [...q.options] as QuizQuestion["options"];
                opts[k] = e.target.value;
                setAt(i, { ...q, options: opts });
              }}
              aria-label={`Câu đố ${i + 1} — ${k === 0 ? "đáp án đúng" : `đáp án sai ${k}`}`}
            />
          ))}
          <button type="button" className="link" onClick={() => onChange(items.filter((_, k) => k !== i))} aria-label={`Xóa câu đố ${i + 1}`}>
            Xóa
          </button>
        </div>
      ))}
      {items.length < 30 && (
        <button type="button" onClick={() => onChange([...items, { question: "", options: ["", "", ""] }])}>
          + Thêm câu đố
        </button>
      )}
    </div>
  );
}
