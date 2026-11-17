import type { SceneConfig } from "../types/protocol";

/** Every box drawn over the LIVE picture: each one can be switched off, and (all but the owner's
 * bubble, which follows the owner's head) dragged and resized in the dashboard's layout preview. */
export type OverlayKey = "banner" | "badges" | "board" | "stage" | "upcoming" | "game" | "caption" | "product" | "owner";

type Bool = { [K in keyof SceneConfig]: SceneConfig[K] extends boolean ? K : never }[keyof SceneConfig];
type Num = { [K in keyof SceneConfig]: SceneConfig[K] extends number ? K : never }[keyof SceneConfig];
type NumOrNull = { [K in keyof SceneConfig]: SceneConfig[K] extends number | null ? K : never }[keyof SceneConfig];

export interface OverlayItem {
  key: OverlayKey;
  /** shown in the dashboard list ("Bảng vàng") */
  label: string;
  /** in a sentence ("bảng vàng") */
  name: string;
  /** what it shows, for the dashboard list */
  hint: string;
  show: Bool;
  /** null: cannot be dragged (it follows something in the 3D shop) */
  place: { x: NumOrNull; y: NumOrNull; scale: Num } | null;
}

export const OVERLAY_ITEMS: OverlayItem[] = [
  {
    key: "banner",
    label: "Màn hình sản phẩm",
    name: "màn hình sản phẩm",
    hint: "Ảnh sản phẩm chạy qua (kiểu Tivi hoặc Bảng; kiểu Màn LED nằm trên tường quán nên không kéo được)",
    show: "banner_enabled",
    place: { x: "banner_x", y: "banner_y", scale: "banner_scale" },
  },
  {
    key: "badges",
    label: "Nhãn DEMO & cảnh báo",
    name: "nhãn trạng thái",
    hint: "Tắt: ẩn cảnh báo “Mất kết nối”. Nhãn DEMO luôn hiện khi chạy Demo để người xem biết đó là sự kiện mô phỏng",
    show: "status_badge_enabled",
    place: { x: "badges_x", y: "badges_y", scale: "badges_scale" },
  },
  {
    key: "board",
    label: "Bảng vàng",
    name: "bảng vàng",
    hint: "Top tặng quà, mua hàng, thắng mini-game",
    show: "board_enabled",
    place: { x: "board_x", y: "board_y", scale: "board_scale" },
  },
  {
    key: "stage",
    label: "Ô Sân khấu",
    name: "ô Sân khấu",
    hint: "Ai đang nhảy, ai kế tiếp, còn bao lâu (sân khấu vẫn chạy khi tắt ô này)",
    show: "stage_board_enabled",
    place: { x: "stage_board_x", y: "stage_board_y", scale: "stage_board_scale" },
  },
  {
    key: "upcoming",
    label: "Bảng Sắp diễn ra",
    name: "bảng Sắp diễn ra",
    hint: "Bài thơ tiếp theo, ai sắp lên cấp, lịch của shop",
    show: "upcoming_enabled",
    place: { x: "upcoming_x", y: "upcoming_y", scale: "upcoming_scale" },
  },
  {
    key: "game",
    label: "Bảng mini-game",
    name: "bảng mini-game",
    hint: "Câu hỏi, đếm ngược, người thắng (tắt bảng: mini-game vẫn chạy, chủ quán vẫn đọc câu hỏi)",
    show: "game_board_enabled",
    place: { x: "game_x", y: "game_y", scale: "game_scale" },
  },
  {
    key: "caption",
    label: "Dòng chữ đang đọc",
    name: "dòng chữ đang đọc",
    hint: "Câu chủ quán / trợ lý đang đọc, ở cuối màn hình (giọng vẫn đọc khi tắt)",
    show: "caption_enabled",
    place: { x: "caption_x", y: "caption_y", scale: "caption_scale" },
  },
  {
    key: "product",
    label: "Thẻ sản phẩm",
    name: "thẻ sản phẩm",
    hint: "Ảnh, tên, giá sản phẩm Chibi đang cầm (khi không có màn hình sản phẩm kiểu Tivi/Bảng)",
    show: "product_card_enabled",
    place: { x: "product_card_x", y: "product_card_y", scale: "product_card_scale" },
  },
  {
    key: "owner",
    label: "Bong bóng lời chủ quán",
    name: "bong bóng lời chủ quán",
    hint: "Lời chào, bài thơ, câu chuyện trên đầu chủ quán (đi theo chủ quán nên không kéo được)",
    show: "owner_bubble_enabled",
    place: null,
  },
];

export const overlayItem = (key: OverlayKey): OverlayItem => OVERLAY_ITEMS.find((i) => i.key === key)!;

/** where the host put it: top-left corner (fraction of the frame), or null for the default spot */
export function spotOf(cfg: SceneConfig, key: OverlayKey): { x: number | null; y: number | null; scale: number } {
  const p = overlayItem(key).place;
  if (!p) return { x: null, y: null, scale: 1 };
  return { x: cfg[p.x] as number | null, y: cfg[p.y] as number | null, scale: (cfg[p.scale] as number) ?? 1 };
}

/** the settings patch that puts it there (null x/y: back to its default spot, at its normal size) */
export function placePatch(key: OverlayKey, x: number | null, y: number | null, scale: number): Partial<SceneConfig> {
  const p = overlayItem(key).place;
  if (!p) return {};
  return { [p.x]: x, [p.y]: y, [p.scale]: scale } as Partial<SceneConfig>;
}

export const isMoved = (cfg: SceneConfig, key: OverlayKey) => {
  const s = spotOf(cfg, key);
  return s.x != null || s.scale !== 1;
};

export const SCALE_MIN = 0.4;
export const SCALE_MAX = 1.8;
