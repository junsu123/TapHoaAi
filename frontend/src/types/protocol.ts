// Wire contract with the backend (SPEC F1/F2). Keep in sync with backend/app.

export interface Point2 {
  x: number;
  z: number;
}

export interface SlotLayout {
  code: string;
  product_id: string | null;
  local: { x: number; y: number; z: number };
}

export interface ShelfLayout {
  code: string;
  name: string;
  transform: { x: number; z: number; rot: number; w: number; d: number; h: number };
  stand_positions: Point2[];
  wait_positions: Point2[];
  slots: SlotLayout[];
}

export interface ProductInfo {
  id: string;
  sku: string;
  name: string;
  price: number | null; // null = not verified → never shown
  currency: string;
  image_url: string | null;
  model_url?: string | null; // approved GLB; the photo box is the fallback
  face_urls?: Partial<Record<"left" | "right" | "back" | "top" | "bottom", string>>; // approved package faces
  box_color?: string | null; // colour of faces without a photo
  card_image_url?: string | null; // nicer image for the on-stream product card
  box_size: { w: number; h: number; d: number };
}

export interface StoreLayout {
  version: number;
  store: {
    width: number;
    depth: number;
    door: Point2;
    counter: { x: number; z: number; w: number; d: number };
  };
  shelves: ShelfLayout[];
  products: ProductInfo[];
}

export interface AvatarInfo {
  avatar_id: string;
  nickname: string;
  unique_id: string | null;
  appearance_seed: number;
  is_demo: boolean;
}

export interface CharacterAction {
  type: "CHARACTER_ACTION";
  command_id: string;
  avatar_id: string;
  product_id: string;
  shelf_id: string;
  slot_id: string;
  stand_index: number;
  action: "WALK_PICKUP_SHOW";
  parameters: { show_seconds: number; camera_priority: number };
}

export interface GameSnapshot {
  type: "SNAPSHOT";
  sequence: number;
  session_id: string | null;
  live_status: string;
  is_demo: boolean;
  layout: StoreLayout;
  avatars: AvatarInfo[];
  active_commands: CharacterAction[];
  camera: { mode: "overview" | "follow"; avatar_id?: string; command_id?: string | null };
  settings: { show_seconds: number };
  scene?: SceneConfig;
  board?: LeaderboardView;
  stage?: StageView;
}

/** The dance stage (whoever comments "nhảy" first dances first). */
export interface StageView {
  enabled: boolean;
  seconds: number;
  max_queue: number;
  current: { name: string; avatar_id: string | null; phase: "calling" | "dancing"; token: string; sent: boolean; seconds_left: number | null } | null;
  queue: { name: string; key?: string }[];
  waiting: number;
  performed: number;
  skipped: number;
  history?: { name: string; skipped: boolean; reason: string; at: number }[];
}

export interface SceneConfig {
  theme: "herbal" | "kawaii";
  sign_text: string;
  tagline: string;
  banner_enabled: boolean;
  banner_mode: "scroll" | "slide";
  banner_focus_on_show: boolean;
  banner_seconds: number;
  banner_height: number; // fraction of the 9:16 frame
  banner_show_price: boolean;
  banner_product_ids: string[]; // empty = every product with a photo
  wall_posters: boolean;
  banner_style: "led" | "tv" | "board";
  owner_enabled: boolean;
  owner_name: string;
  owner_greet_template: string;
  owner_tea_template: string;
  owner_buy_template: string;
  board_enabled: boolean;
  board_position: "left" | "right";
  board_scope: "session" | "all";
  board_size: number;
  board_x: number | null; // dragged position: top-left corner, fraction of the frame
  board_y: number | null;
  board_scale: number;
  // Chibi behaviour (spec V3 §5, §11): autonomous life on/off, weights of each activity group,
  // how many Chibis may be on screen at once
  chibi_autonomous: boolean;
  chibi_w_browse: number;
  chibi_w_explore: number;
  chibi_w_idle: number;
  chibi_w_social: number;
  chibi_w_rest: number;
  chibi_w_fun: number;
  chibi_max_visible: number;
  stage_enabled: boolean;
  stage_seconds: number;
  stage_max_queue: number;
  stage_side: "center" | "right" | "left";
  stage_layout_v: number;
  stage_board_x: number | null; // the "Sân khấu" box dragged by the host: top-left, fraction of the frame
  stage_board_y: number | null;
  stage_board_scale: number;
  /** show a viewer's comment (and the owner's reply) as text on screen; off = only read aloud */
  chat_on_screen: boolean;
}

export interface LeaderboardView {
  gifts: { name: string; gifts: number; coins: number }[];
  buyers: { name: string; items: number; amount: number; orders: number }[];
  recent_purchases: { id: string; name: string; product: string; qty: number; amount: number; at: number }[];
  scope: "session" | "all";
  total_gifts: number;
  total_orders: number;
}

export const DEFAULT_SCENE: SceneConfig = {
  theme: "herbal",
  sign_text: "TIỆM TRÀ THẢO MỘC",
  tagline: "Trà sạch · Thảo mộc Việt",
  banner_enabled: true,
  banner_mode: "scroll",
  banner_focus_on_show: true,
  banner_seconds: 6,
  banner_height: 0.24,
  banner_show_price: true,
  banner_product_ids: [],
  wall_posters: true,
  banner_style: "led",
  owner_enabled: true,
  owner_name: "Chủ quán",
  owner_greet_template: "Xin chào quý khách {ten} đã vào quán!",
  owner_tea_template: "Mời {ten} dùng trà ạ! Cảm ơn {ten} đã tặng {qua}!",
  owner_buy_template: "Cảm ơn {ten} đã mua {san_pham} ạ!",
  board_enabled: true,
  board_position: "left",
  board_scope: "session",
  board_size: 5,
  board_x: null,
  board_y: null,
  board_scale: 1,
  chibi_autonomous: true,
  chibi_w_browse: 30,
  chibi_w_explore: 25,
  chibi_w_idle: 20,
  chibi_w_social: 10,
  chibi_w_rest: 10,
  chibi_w_fun: 5,
  chibi_max_visible: 60,
  stage_enabled: true,
  stage_seconds: 15,
  stage_max_queue: 30,
  stage_side: "center",
  stage_layout_v: 2,
  stage_board_x: null,
  stage_board_y: null,
  stage_board_scale: 1,
  chat_on_screen: false,
};

export interface SpeechClip {
  id: string;
  kind: "question" | "answer" | "test" | "comment" | "greeting" | "product" | "welcome" | "stage" | "poem" | "story";
  label: string;
  text: string;
  url: string | null;
  caption_only?: boolean;
  /** no Vbee audio: read it with the computer's own Vietnamese voice (Web Speech) */
  fallback?: { name: string | null; rate: number; lang: string } | null;
}

export type ServerGameMessage =
  | GameSnapshot
  | (CharacterAction & { sequence: number })
  | { type: "AVATAR_SPAWN"; sequence: number; avatar: AvatarInfo }
  | { type: "AVATAR_UPDATE"; sequence: number; avatar: AvatarInfo }
  | { type: "AVATAR_EXIT"; sequence: number; avatar_id: string; reason: string }
  | { type: "PREEMPT"; sequence: number; command_id: string; avatar_id: string }
  | { type: "WAIT_NEAR_SHELF"; sequence: number; command_id: string; avatar_id: string; shelf_id: string; wait_index: number }
  | { type: "RESET_AVATAR"; sequence: number; avatar_id: string; command_id: string; reason: string }
  | { type: "CAMERA_FOCUS"; sequence: number; mode: "overview" | "follow"; avatar_id?: string; command_id?: string | null }
  | { type: "SOCIAL_EFFECT"; sequence: number; kind: string; avatar_id: string | null; count?: number }
  | { type: "LAYOUT_UPDATED"; sequence: number; layout: StoreLayout }
  | { type: "SCENE_UPDATED"; sequence: number; scene: SceneConfig }
  | { type: "OWNER_GREET"; sequence: number; text: string; names: string[]; more: number }
  | { type: "OWNER_TEA"; sequence: number; avatar_id: string | null; name: string; text: string }
  | { type: "OWNER_THANKS"; sequence: number; text: string }
  | { type: "OWNER_SAY"; sequence: number; text: string; kind: string }
  | { type: "STAGE_STATE"; sequence: number; stage: StageView }
  | { type: "STAGE_PERFORM"; sequence: number; avatar_id: string; token: string; name: string; seconds: number }
  | { type: "STAGE_END"; sequence: number; avatar_id: string; token: string }
  | { type: "LEADERBOARD"; sequence: number; board: LeaderboardView }
  | { type: "LIVE_STATUS"; sequence: number; status: string; is_demo: boolean }
  | { type: "SESSION"; sequence: number; session_id: string | null; is_demo: boolean }
  | { type: "SPEECH"; sequence: number; clip: SpeechClip }
  | { type: "SPEECH_STOP"; sequence: number }
  | { type: "SPEECH_HOLD"; sequence: number; hold: boolean }
  | { type: "PONG"; sequence?: number };

export type ClientGameMessage =
  | { type: "ACK" | "ACTION_STARTED"; command_id: string }
  | { type: "ACTION_PROGRESS"; command_id: string; phase: string }
  | { type: "ACTION_COMPLETED"; command_id: string; reason?: string }
  | { type: "ACTION_FAILED"; command_id: string; reason: string }
  | { type: "FPS_REPORT"; fps: number; quality: string; avatars: number }
  | ({ type: "PERF_REPORT" } & PerfReport)
  | { type: "SPEECH_STARTED" | "SPEECH_ENDED"; id: string }
  | { type: "STAGE_PROGRESS"; token: string; phase: "on_stage" | "failed" }
  | { type: "SPEECH_FAILED"; id: string; reason: string }
  | {
      type: "PLAYER_INFO";
      speech_api: boolean;
      voice_count: number;
      voices: { name: string; lang: string; local: boolean }[];
      fallback_voice: string | null;
      blocked: boolean;
      user_agent: string;
    }
  | { type: "PING" }
  | { type: "RESYNC" };

/** Game page performance, sent every few seconds by the OBS page (spec V3 §10, T16). */
export interface PerfReport {
  fps: number;
  frame_ms_p95: number; // slowest 5 % of frames
  sim_ms: number; // Chibi logic per frame (CPU)
  render_calls: number; // draw calls per frame (GPU load)
  triangles: number;
  heap_mb: number | null; // JS memory (Chrome / OBS only)
  gpu: string | null; // graphics card the browser uses
  quality: string;
  avatars: number;
  lod: { full: number; reduced: number; far: number; hidden: number };
  window_px?: [number, number]; // size of the game window in real screen pixels
  render_px?: [number, number]; // size of the picture drawn (bigger with "Nét nhất")
}
