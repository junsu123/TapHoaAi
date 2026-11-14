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
}

export interface SpeechClip {
  id: string;
  kind: "question" | "answer" | "test" | "comment" | "greeting" | "product" | "welcome";
  label: string;
  text: string;
  url: string | null;
  caption_only?: boolean;
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
  | { type: "SPEECH_STARTED" | "SPEECH_ENDED"; id: string }
  | { type: "SPEECH_FAILED"; id: string; reason: string }
  | { type: "PING" }
  | { type: "RESYNC" };
