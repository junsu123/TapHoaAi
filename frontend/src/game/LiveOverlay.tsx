// 2D overlay inside the 9:16 frame: product card, DEMO label, connection banner, the boards.
// (The product screen is the LED screen on the shop's back wall: LedWall, in the 3D scene.)
// Everything sits inside configurable safe areas so TikTok's own UI never covers it (H4).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { isChatClip, type SpeechView } from "./SpeechPlayer";
import { formatVnd } from "../lib/api";
import type { GameView, LeaderboardView, ProductInfo, SceneConfig, SpeechClip, UpcomingView } from "../types/protocol";
import type { GameEngine } from "./GameEngine";
import { SCALE_MAX, SCALE_MIN, spotOf, type OverlayKey } from "./overlayItems";

export interface SafeArea {
  top: number;
  bottom: number;
  right: number;
  left: number;
}

interface OverlayState {
  product: ProductInfo | null;
  nickname: string | null;
  isDemo: boolean;
  liveStatus: string;
  scene: SceneConfig;
  bannerIds: string;
  board: LeaderboardView | null;
  teaShot: boolean;
}

const BAD_STATUSES = new Set([
  "Mất kết nối",
  "Đã kết thúc",
  "Không hỗ trợ",
  "Không phát LIVE",
]);

/** Speech bubble over the shop owner's head (follows the camera every frame). */
function OwnerBubble({ engine }: { engine: GameEngine }) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<{ t: string; kind: string } | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = "";
    const tick = () => {
      const b = engine.scene.owner_enabled && engine.scene.owner_bubble_enabled ? engine.tea.bubble : null;
      const key = b ? `${b.kind}|${b.text}` : "";
      if (key !== last) {
        last = key;
        setText(b ? { t: b.text, kind: b.kind } : null);
      }
      const el = ref.current;
      if (el) {
        const p = engine.ownerScreen;
        // keep the whole bubble (≈ 60 % of the frame width at most) inside the frame
        el.style.left = `${Math.min(0.69, Math.max(0.31, p.x)) * 100}%`;
        el.style.top = `${Math.min(0.85, Math.max(0.2, p.y)) * 100}%`;
        el.style.visibility = p.visible ? "visible" : "hidden";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);
  return (
    <div ref={ref} className="owner-bubble-anchor">
      {text && (
        <div className={`owner-bubble ${text.kind}`} key={text.t} data-testid="owner-bubble" data-kind={text.kind}>
          {text.t}
        </div>
      )}
    </div>
  );
}

/** Drag a box on the LIVE screen (edit mode only): move it, or resize it from its corner handle.
 * Dropping it tells the dashboard (which saves the spot) with a postMessage of `msgType`. */
function useOverlayDrag(editable: boolean, scene: SceneConfig, item: OverlayKey) {
  const saved = spotOf(scene, item);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; scale: number } | null>(null);
  const gesture = useRef<{ kind: "move" | "size"; px: number; py: number; x: number; y: number; scale: number; w: number; h: number; sw: number; sh: number } | null>(null);
  // the saved position arrived: drop the local drag state
  useEffect(() => setDrag(null), [saved.x, saved.y, saved.scale]);
  const placed = drag ?? (saved.x != null && saved.y != null ? { x: saved.x, y: saved.y, scale: saved.scale } : null);
  const scale = drag?.scale ?? saved.scale ?? 1;
  const begin = (kind: "move" | "size") => (e: PointerEvent) => {
    if (!editable || !ref.current) return;
    e.preventDefault();
    e.stopPropagation();
    const frame = (ref.current.offsetParent as HTMLElement).getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    gesture.current = {
      kind,
      px: e.clientX,
      py: e.clientY,
      x: (r.left - frame.left) / frame.width,
      y: (r.top - frame.top) / frame.height,
      scale,
      w: r.width,
      h: r.height,
      sw: frame.width,
      sh: frame.height,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "move") {
      const x = Math.min(Math.max(0, g.x + (e.clientX - g.px) / g.sw), Math.max(0, 1 - g.w / g.sw));
      const y = Math.min(Math.max(0, g.y + (e.clientY - g.py) / g.sh), Math.max(0, 1 - g.h / g.sh));
      setDrag({ x, y, scale: g.scale });
    } else {
      const k = Math.min(SCALE_MAX, Math.max(SCALE_MIN, g.scale * (1 + (e.clientX - g.px) / g.w)));
      setDrag({ x: g.x, y: g.y, scale: Math.round(k * 100) / 100 });
    }
  };
  const end = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || !drag) return;
    const msg = { type: "chibi-overlay", item, x: Math.round(drag.x * 1000) / 1000, y: Math.round(drag.y * 1000) / 1000, scale: drag.scale };
    if (window.parent !== window) window.parent.postMessage(msg, location.origin);
  };
  const handlers = { onPointerDown: begin("move"), onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  const resizeHandlers = { onPointerDown: begin("size"), onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  /** style for a box placed by hand (null: the box keeps its default spot) */
  const placedStyle: CSSProperties | null = placed
    ? { position: "absolute", left: `${placed.x * 100}%`, top: `${placed.y * 100}%`, right: "auto", bottom: "auto", margin: 0, transform: `scale(${scale})`, transformOrigin: "top left" }
    : null;
  return { ref, scale, placedStyle, handlers: editable ? handlers : {}, resizeHandlers };
}

type Drag = ReturnType<typeof useOverlayDrag>;

/** Edit mode: the hint and the corner handle that resizes the box. */
function EditHandles({ d, testId, label, hint = false }: { d: Drag; testId: string; label: string; hint?: boolean }) {
  return (
    <>
      {hint && <span className="hb-edit-hint">Kéo để di chuyển, kéo góc để đổi cỡ</span>}
      <span className="hb-resize" data-testid={testId} {...d.resizeHandlers} aria-label={label} />
    </>
  );
}

/** "DEMO · sự kiện mô phỏng" and the connection warning, top of the frame. The DEMO label cannot
 * be switched off: viewers must be able to tell simulated events from real ones. */
function Badges({ scene, isDemo, warning, editable, sample }: { scene: SceneConfig; isDemo: boolean; warning: string | null; editable: boolean; sample: boolean }) {
  const d = useOverlayDrag(editable, scene, "badges");
  const warn = warning && scene.status_badge_enabled ? warning : null;
  const showSample = editable && sample && !isDemo && !warn;
  if (!isDemo && !warn && !showSample) return null;
  return (
    <div
      ref={d.ref}
      className={`overlay-badges${editable ? " ov-edit" : ""}`}
      data-testid="overlay-badges"
      data-placed={d.placedStyle ? "1" : undefined}
      style={d.placedStyle ?? undefined}
      {...d.handlers}
    >
      {isDemo && (
        <span className="badge-demo" data-testid="demo-badge">
          DEMO · sự kiện mô phỏng
        </span>
      )}
      {warn && (
        <span className="badge-warn" data-testid="status-banner">
          ⚠ {warn}
        </span>
      )}
      {showSample && <span className="badge-demo sample">Nhãn DEMO / cảnh báo (mẫu)</span>}
      {editable && <EditHandles d={d} testId="badges-resize" label="Đổi cỡ nhãn trạng thái" />}
    </div>
  );
}

/** The line of what is being read aloud (bottom of the frame). */
function Caption({
  scene,
  speech,
  hiddenChat,
  ownerOn,
  editable,
  sample,
}: {
  scene: SceneConfig;
  speech?: SpeechView;
  hiddenChat: (c: SpeechClip) => boolean;
  ownerOn: boolean;
  editable: boolean;
  sample: boolean;
}) {
  const d = useOverlayDrag(editable, scene, "caption");
  const clip: SpeechClip | null =
    speech?.clip ??
    (editable && sample && scene.caption_enabled
      ? ({ id: "sample", kind: "test", label: scene.owner_name || "Chủ quán", text: "Câu đang được đọc hiện ở đây (mẫu)" } as SpeechClip)
      : null);
  if (!clip) return null;
  const hidden = hiddenChat(clip) || !scene.caption_enabled;
  return (
    <div
      ref={d.ref}
      className={`speech-caption speech-${clip.kind}${speech?.held ? " held" : ""}${hidden ? " off-screen" : ""}${editable ? " ov-edit" : ""}`}
      data-testid="speech-caption"
      data-kind={clip.kind}
      data-hidden={hidden ? "1" : undefined}
      data-placed={d.placedStyle ? "1" : undefined}
      style={d.placedStyle ?? undefined}
      {...d.handlers}
    >
      <span className="speech-label">
        {clip.label === "Trợ lý AI" ? "🤖" : "🔊"} {clip.label}
      </span>
      {/* a poem / story is already in the owner's bubble: the caption only says what is playing */}
      {!((clip.kind === "poem" || clip.kind === "story") && ownerOn) && <span className="speech-text">{clip.text}</span>}
      {editable && <EditHandles d={d} testId="caption-resize" label="Đổi cỡ dòng chữ đang đọc" />}
    </div>
  );
}

/** The product a Chibi is showing (when there is no TV / board frame on top to show it). */
function ProductCard({ scene, product, nickname, editable }: { scene: SceneConfig; product: ProductInfo | null; nickname: string | null; editable: boolean }) {
  const d = useOverlayDrag(editable, scene, "product");
  if (!scene.product_card_enabled) return null;
  const p: ProductInfo | null = product ?? (editable ? ({ id: "sample", name: "Sản phẩm Chibi đang cầm (mẫu)", sku: "MẪU", price: null } as unknown as ProductInfo) : null);
  if (!p) return null;
  const price = formatVnd(p.price);
  return (
    <div
      ref={d.ref}
      className={`product-card${editable ? " ov-edit" : ""}`}
      data-testid="product-card"
      data-product-id={p.id}
      data-placed={d.placedStyle ? "1" : undefined}
      style={d.placedStyle ?? undefined}
      {...d.handlers}
    >
      {(p.card_image_url || p.image_url) && <img src={p.card_image_url || p.image_url!} alt={p.name} className={p.card_image_url ? "card-photo" : undefined} />}
      <div className="product-card-body">
        {nickname && <div className="product-card-who">{nickname} đang xem</div>}
        <div className="product-card-name">{p.name}</div>
        <div className="product-card-sku">SKU: {p.sku}</div>
        {price && <div className="product-card-price">{price}</div>}
      </div>
      {editable && <EditHandles d={d} testId="product-card-resize" label="Đổi cỡ thẻ sản phẩm" />}
    </div>
  );
}

/** “Sắp diễn ra”: what is coming up, soonest first, with live countdowns — and how to join in. */
function UpcomingBoard({ engine, safe, scene, editable }: { engine: GameEngine; safe: SafeArea; scene: SceneConfig; editable: boolean }) {
  const d = useOverlayDrag(editable, scene, "upcoming");
  const [v, setV] = useState<UpcomingView | null>(engine.upcoming);
  const [now, setNow] = useState(() => Date.now());
  const [tip, setTip] = useState(0);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      setV(engine.upcoming);
      setNow(Date.now());
      setAway(engine.tea.cameraOnTable() || engine.stageShot() || engine.game != null); // close-ups, mini-game: step aside
    }, 500);
    const t = setInterval(() => setTip((n) => n + 1), 6000);
    return () => {
      clearInterval(id);
      clearInterval(t);
    };
  }, [engine]);
  if (!v || !v.enabled || (!v.rows.length && !v.tips.length)) return null;
  const tips = v.tips;
  return (
    <div
      ref={d.ref}
      className={`upcoming-board${editable ? " editable" : ""}${away && !editable ? " away" : ""}`}
      data-testid="upcoming-board"
      data-placed={d.placedStyle ? "1" : undefined}
      style={
        d.placedStyle ?? {
          top: `${(safe.top + 0.36) * 100}%`,
          left: `${(safe.left + 0.02) * 100}%`,
          transform: `scale(${d.scale})`,
          transformOrigin: "top left",
        }
      }
      {...d.handlers}
    >
      <div className="upcoming-title">Sắp diễn ra</div>
      {v.rows.map((r, i) => (
        <div key={`${r.kind}-${i}`} className={`upcoming-row up-${r.kind}`} data-testid={`upcoming-${r.kind}`}>
          <span className="up-icon" aria-hidden>
            {r.icon}
          </span>
          <span className="up-text">{r.text}</span>
          <span className="up-when">{whenText(r.due, now, r.clock)}</span>
        </div>
      ))}
      {tips.length > 0 && (
        <div className="upcoming-tip" key={tip % tips.length} data-testid="upcoming-tip">
          {tips[tip % tips.length]}
        </div>
      )}
      {editable && (
        <>
          <span className="hb-edit-hint">Kéo để di chuyển, kéo góc để đổi cỡ</span>
          <span className="hb-resize" data-testid="upcoming-board-resize" {...d.resizeHandlers} aria-label="Đổi cỡ bảng sắp diễn ra" />
        </>
      )}
    </div>
  );
}

const GAME_ICON = { price: "💰", quiz: "❓", keyword: "⚡" } as const;
const GAME_HOW = { price: "Bình luận giá bạn đoán (nghìn đồng)", quiz: "Bình luận A, B hoặc C", keyword: "Bình luận đúng chữ này thật nhanh" } as const;

/** The mini-game round: the question, a countdown bar, how many answered — then the answer and the winners. */
function GamePanel({ engine, safe, scene, editable }: { engine: GameEngine; safe: SafeArea; scene: SceneConfig; editable: boolean }) {
  const d = useOverlayDrag(editable, scene, "game");
  const [g, setG] = useState<GameView | null>(engine.game);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setG(engine.game);
      setNow(Date.now());
    }, 250);
    return () => clearInterval(id);
  }, [engine]);
  // edit mode: a sample round to place the panel
  const shown: GameView | null =
    g ??
    (editable && scene.minigame_enabled && engine.sceneVersion > 0 // (the shop's real settings, not the defaults before they load)
      ? { id: "x", kind: "quiz", title: "Đố vui", phase: "open", opens_at: now, closes_at: now + 30000, ends_at: now + 40000, answers: 12, question: "Câu hỏi mẫu để đặt chỗ bảng mini-game?", options: ["Đáp án A", "Đáp án B", "Đáp án C"] }
      : null);
  if (!shown || !scene.game_board_enabled) return null;
  const left = Math.max(0, Math.ceil(((shown.phase === "intro" ? shown.closes_at : shown.closes_at) - now) / 1000));
  const total = Math.max(1, (shown.closes_at - shown.opens_at) / 1000);
  const frac = shown.phase === "open" ? Math.min(1, Math.max(0, (shown.closes_at - now) / 1000 / total)) : shown.phase === "intro" ? 1 : 0;
  const reveal = shown.phase === "reveal";
  return (
    <div
      ref={d.ref}
      className={`game-panel game-${shown.kind} phase-${shown.phase}${editable ? " editable" : ""}`}
      data-testid="game-panel"
      data-phase={shown.phase}
      data-kind={shown.kind}
      data-placed={d.placedStyle ? "1" : undefined}
      style={
        d.placedStyle ?? {
          top: `${(safe.top + 0.36) * 100}%`,
          left: `${(safe.left + 0.02) * 100}%`,
          transform: `scale(${d.scale})`,
          transformOrigin: "top left",
        }
      }
      {...d.handlers}
    >
      <div className="gp-head">
        <span className="gp-icon" aria-hidden>
          {GAME_ICON[shown.kind]}
        </span>
        <span className="gp-title">Mini-game: {shown.title}</span>
        {!reveal && <span className="gp-time" data-testid="game-time">{shown.phase === "intro" ? "Sắp bắt đầu" : `${left}s`}</span>}
      </div>
      {shown.kind === "price" && (
        <div className="gp-product">
          {shown.image && <img src={shown.image} alt="" />}
          <div>
            <div className="gp-q">{shown.product} giá bao nhiêu?</div>
            {reveal && shown.price != null && <div className="gp-answer" data-testid="game-answer">Giá đúng: {formatVnd(shown.price)}</div>}
          </div>
        </div>
      )}
      {shown.kind === "quiz" && (
        <>
          <div className="gp-q">{shown.question}</div>
          <ol className="gp-options">
            {(shown.options ?? []).map((o, i) => (
              <li key={i} className={reveal && shown.answer === i ? "right" : reveal ? "wrong" : ""}>
                <b>{"ABC"[i]}</b> {o}
              </li>
            ))}
          </ol>
        </>
      )}
      {shown.kind === "keyword" && <div className="gp-keyword" data-testid="game-keyword">{shown.keyword}</div>}
      {!reveal && (
        <>
          <div className="gp-bar" aria-hidden>
            <span style={{ width: `${frac * 100}%` }} />
          </div>
          <div className="gp-foot">
            <span>{GAME_HOW[shown.kind]}</span>
            <span data-testid="game-answers">{shown.answers} bạn đã trả lời</span>
          </div>
        </>
      )}
      {reveal && (
        <div className="gp-winners" data-testid="game-winners">
          {shown.winners && shown.winners.length > 0 ? (
            <>
              <div className="gp-win-title">🏅 Người thắng</div>
              {shown.winners.map((w, i) => (
                <div key={i} className="gp-win">
                  {w}
                  {shown.kind === "price" && shown.closest?.[0] && i === 0 && <span className="muted"> · đoán {formatVnd(shown.closest[0].guess)}</span>}
                </div>
              ))}
            </>
          ) : (
            <div className="gp-win-title">Chưa có ai thắng — lần sau nha!</div>
          )}
        </div>
      )}
      {editable && (
        <>
          <span className="hb-edit-hint">Kéo để di chuyển, kéo góc để đổi cỡ</span>
          <span className="hb-resize" data-testid="game-board-resize" {...d.resizeHandlers} aria-label="Đổi cỡ bảng mini-game" />
        </>
      )}
    </div>
  );
}

/** About how long until their turn: "~40 giây", "~3 phút". */
export function etaText(s: number): string {
  if (s < 60) return `~${Math.max(10, Math.round(s / 10) * 10)} giây`;
  return `~${Math.round(s / 60)} phút`;
}

/** "đang diễn ra" / "45 giây" / "4 phút" / "22:10" (more than an hour away). */
export function whenText(due: number | null, now: number, clock?: string): string {
  if (due == null) return "đang diễn ra";
  const s = Math.round((due - now) / 1000);
  if (s <= 5) return "sắp bắt đầu";
  if (s < 60) return `${s} giây`;
  if (s < 3600) return `${Math.ceil(s / 60)} phút`;
  return clock ?? new Date(due).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

/** The dance stage line: who dances now, who is next — and how to join. */
function StageBoard({ engine, safe, scene, editable }: { engine: GameEngine; safe: SafeArea; scene: SceneConfig; editable: boolean }) {
  const d = useOverlayDrag(editable, scene, "stage");
  const [v, setV] = useState(engine.stage);
  const [enabled, setEnabled] = useState(engine.scene.stage_enabled);
  const tvTop = () => engine.scene.banner_enabled; // TV frame on top or the LED wall screen: stay below it
  const [belowTv, setBelowTv] = useState(tvTop());
  useEffect(() => {
    let last = "";
    const id = setInterval(() => {
      const st = engine.stage;
      const key = JSON.stringify([engine.scene.stage_enabled, tvTop(), st?.current?.name, st?.current?.phase, st?.current?.seconds_left, st?.queue.map((q) => q.name), st?.waiting]);
      if (key !== last) {
        last = key;
        setV(st);
        setEnabled(engine.scene.stage_enabled);
        setBelowTv(tvTop());
      }
    }, 250);
    return () => clearInterval(id);
  }, [engine]);
  if (!enabled || !scene.stage_board_enabled) return null;
  const cur = v?.current ?? null;
  const next = v?.queue.slice(0, 4) ?? [];
  const more = Math.max(0, (v?.waiting ?? 0) - next.length);
  return (
    <div
      ref={d.ref}
      className={`stage-board${editable ? " editable" : ""}`}
      data-testid="stage-board"
      data-placed={d.placedStyle ? "1" : undefined}
      style={
        d.placedStyle ?? {
          top: `${(safe.top + (belowTv ? 0.36 : 0.075)) * 100}%`,
          right: `${(safe.right + 0.02) * 100}%`,
          transform: `scale(${d.scale})`,
          transformOrigin: "top right",
        }
      }
      {...d.handlers}
    >
      <div className="stage-board-title">🎤 Sân khấu</div>
      {cur ? (
        <div className="stage-now" data-testid="stage-current" data-phase={cur.phase}>
          <span>{cur.phase === "dancing" ? "Đang nhảy" : "Mời lên"}</span>
          <b>{cur.name}</b>
          {cur.phase === "dancing" && cur.seconds_left !== null && <i>{cur.seconds_left}s</i>}
        </div>
      ) : null}
      {next.length > 0 && (
        <ol className="stage-next" data-testid="stage-next">
          {next.map((q, i) => (
            <li key={`${i}-${q.name}`}>
              <span className="sn-name">{q.name}</span>
              {q.eta_s != null && <span className="sn-eta">{etaText(q.eta_s)}</span>}
            </li>
          ))}
          {more > 0 && <li className="more">+{more} bạn nữa</li>}
        </ol>
      )}
      <div className="stage-hint">Bình luận “nhảy” để lên sân khấu</div>
      {editable && (
        <>
          <span className="hb-edit-hint">Kéo để di chuyển, kéo góc để đổi cỡ</span>
          <span className="hb-resize" data-testid="stage-board-resize" {...d.resizeHandlers} aria-label="Đổi cỡ ô sân khấu" />
        </>
      )}
    </div>
  );
}

const MEDAL = ["gold", "silver", "bronze"];

/** "Bảng vàng": top gift givers and top buyers, taking turns. Placed in a corner, or wherever
 * the host dragged it (edit mode: the dashboard's layout preview loads the page with edit=board). */
function HonourBoard({ board, scene, hidden, editable }: { board: LeaderboardView | null; scene: SceneConfig; hidden: boolean; editable: boolean }) {
  const [tab, setTab] = useState<"gifts" | "buyers" | "games">("gifts");
  const d = useOverlayDrag(editable, scene, "board");
  const hasGames = (board?.games?.length ?? 0) > 0; // the "Mini-game" tab once someone has won
  useEffect(() => {
    const id = setInterval(
      () => setTab((t) => (t === "gifts" ? "buyers" : t === "buyers" && hasGames ? "games" : "gifts")),
      8000,
    );
    return () => clearInterval(id);
  }, [hasGames]);
  const rows =
    tab === "gifts"
      ? (board?.gifts ?? []).map((g) => ({ name: g.name, value: g.coins > 0 ? `${g.coins.toLocaleString("vi-VN")} xu` : `${g.gifts} quà` }))
      : tab === "buyers"
        ? (board?.buyers ?? []).map((b) => ({ name: b.name, value: b.amount > 0 ? (formatVnd(b.amount) ?? "") : `${b.items} sản phẩm` }))
        : (board?.games ?? []).map((g) => ({ name: g.name, value: `${g.wins} lần thắng` }));
  const style: CSSProperties = d.placedStyle ?? { transform: `scale(${d.scale})`, transformOrigin: scene.board_position === "right" ? "bottom right" : "bottom left" };

  return (
    <div
      ref={d.ref}
      className={`honour-board ${scene.board_position}${hidden && !editable ? " away" : ""}${editable ? " editable" : ""}`}
      style={style}
      data-testid="honour-board"
      data-tab={tab}
      {...d.handlers}
    >
      <div className="hb-head">
        <span className="hb-crown" aria-hidden>
          👑
        </span>
        <span className="hb-title">Bảng vàng</span>
      </div>
      <div className="hb-tabs">
        <span className={tab === "gifts" ? "on" : ""}>Tặng quà</span>
        <span className={tab === "buyers" ? "on" : ""}>Mua hàng</span>
        {hasGames && <span className={tab === "games" ? "on" : ""}>Mini-game</span>}
      </div>
      <ol className="hb-list" key={tab}>
        {rows.length === 0 && <li className="hb-empty">{tab === "gifts" ? "Tặng quà để lên bảng vàng!" : tab === "buyers" ? "Mua hàng để lên bảng vàng!" : "Thắng mini-game để lên bảng vàng!"}</li>}
        {rows.slice(0, scene.board_size).map((r, i) => (
          <li key={`${r.name}-${i}`}>
            <span className={`hb-rank ${MEDAL[i] ?? ""}`}>{i + 1}</span>
            <span className="hb-name">{r.name}</span>
            <span className="hb-value">{r.value}</span>
          </li>
        ))}
      </ol>
      {editable && (
        <>
          <span className="hb-edit-hint">Kéo để di chuyển, kéo góc để đổi cỡ</span>
          <span className="hb-resize" data-testid="board-resize" {...d.resizeHandlers} aria-label="Đổi cỡ bảng vàng" />
        </>
      )}
    </div>
  );
}

export function LiveOverlay({
  engine,
  safe,
  socketUp,
  speech,
  onUnlockAudio,
}: {
  engine: GameEngine;
  safe: SafeArea;
  socketUp: boolean;
  speech?: SpeechView;
  onUnlockAudio?: () => void;
}) {
  // the dashboard's layout preview: the honour board can be dragged and resized
  const editBoard = useMemo(() => new URLSearchParams(location.search).get("edit") === "board", []);
  // a viewer's chat (and the owner's reply) is only read aloud — unless the shop wants it on screen,
  // or there is no audio (caption only): then the words would be lost
  const chatHidden = (clip: SpeechClip) => isChatClip(clip) && !engine.scene.chat_on_screen && !clip.caption_only;
  const [st, setSt] = useState<OverlayState>({
    product: null,
    nickname: null,
    isDemo: false,
    liveStatus: "",
    scene: engine.scene,
    bannerIds: "",
    board: engine.board,
    teaShot: false,
  });
  useEffect(() => {
    const id = setInterval(() => {
      const sc = engine.showcase();
      setSt((prev) => {
        const next = {
          product: sc?.product ?? null,
          nickname: sc?.avatar.info.nickname ?? null,
          isDemo: engine.isDemo,
          liveStatus: engine.liveStatus,
          scene: engine.scene,
          board: engine.board,
          teaShot: engine.tea.cameraOnTable() || engine.stageShot() || engine.game != null, // close-ups (tea, dance stage), a mini-game round: the board steps aside
          bannerIds: engine.bannerProducts().map((p) => `${p.id}:${p.card_image_url ?? p.image_url}:${p.price}`).join(","),
        };
        return prev.product?.id === next.product?.id &&
          prev.nickname === next.nickname &&
          prev.isDemo === next.isDemo &&
          prev.liveStatus === next.liveStatus &&
          prev.scene === next.scene &&
          prev.board === next.board &&
          prev.teaShot === next.teaShot &&
          prev.bannerIds === next.bannerIds
          ? prev
          : next;
      });
    }, 150);
    return () => clearInterval(id);
  }, [engine]);

  return (
    <div
      className="overlay"
      style={{
        paddingTop: `${safe.top * 100}%`,
        paddingBottom: `${safe.bottom * 100}%`,
        paddingRight: `${safe.right * 100}%`,
        paddingLeft: `${safe.left * 100}%`,
      }}
    >
      <div className="overlay-top">
        <Badges
          scene={st.scene}
          isDemo={st.isDemo}
          warning={!socketUp ? "Mất kết nối máy chủ" : BAD_STATUSES.has(st.liveStatus) ? st.liveStatus : null}
          editable={editBoard}
          sample={engine.sceneVersion > 0}
        />
      </div>
      {st.scene.board_enabled && <HonourBoard board={st.board} scene={st.scene} hidden={st.teaShot} editable={editBoard} />}
      <OwnerBubble engine={engine} />
      <StageBoard engine={engine} safe={safe} scene={st.scene} editable={editBoard} />
      {st.scene.upcoming_enabled && <UpcomingBoard engine={engine} safe={safe} scene={st.scene} editable={editBoard} />}
      <GamePanel engine={engine} safe={safe} scene={st.scene} editable={editBoard} />
      <div className="overlay-bottom">
        {speech?.blocked && (
          <button
            className="audio-unlock"
            onClick={onUnlockAudio}
            data-testid="audio-unlock"
          >
            🔈 Bấm để bật âm thanh
          </button>
        )}
        <Caption scene={st.scene} speech={speech} hiddenChat={chatHidden} ownerOn={engine.scene.owner_enabled} editable={editBoard} sample={engine.sceneVersion > 0} />
        {(st.product || editBoard) && <ProductCard scene={st.scene} product={st.product} nickname={st.nickname} editable={editBoard && engine.sceneVersion > 0} />}
      </div>
    </div>
  );
}
