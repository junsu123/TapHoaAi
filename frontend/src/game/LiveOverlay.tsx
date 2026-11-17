// 2D overlay inside the 9:16 frame: product card, DEMO label, connection banner.
// Everything sits inside configurable safe areas so TikTok's own UI never covers it (H4).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { isChatClip, type SpeechView } from "./SpeechPlayer";
import { formatVnd } from "../lib/api";
import type { GameView, LeaderboardView, ProductInfo, SceneConfig, SpeechClip, UpcomingView } from "../types/protocol";
import type { GameEngine } from "./GameEngine";

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

/** Big product photo across the top of the frame: rotates through the products and jumps to the
 * one a viewer is looking at. */
function ScrollCard({ p, showPrice, hot }: { p: ProductInfo; showPrice: boolean; hot: boolean }) {
  const img = p.card_image_url || p.image_url;
  const price = showPrice ? formatVnd(p.price) : null;
  return (
    <div className={`scroll-card${hot ? " hot" : ""}`} data-product-id={p.id}>
      <div className="scroll-photo">{img ? <img src={img} alt={p.name} /> : <span className="banner-noimg">🍵</span>}</div>
      <div className="scroll-caption">
        <span className="scroll-name">{p.name}</span>
        {price && <span className="scroll-price">{price}</span>}
      </div>
    </div>
  );
}

/** Product photos running past continuously, like a conveyor; the strip is doubled so the loop is seamless. */
function ScrollTrack({ list, scene, hotId }: { list: ProductInfo[]; scene: SceneConfig; hotId: string | null }) {
  const reps = Math.max(1, Math.ceil(5 / list.length));
  const half = Array.from({ length: reps }, () => list).flat();
  const seconds = half.length * scene.banner_seconds;
  return (
    <div className="scroll-viewport">
      <div
        className="scroll-track"
        key={`${list.map((p) => p.id).join(",")}|${seconds}`}
        style={{ animationDuration: `${seconds}s` }}
        data-testid="banner-track"
      >
        {[...half, ...half].map((p, k) => (
          <ScrollCard key={`${k}-${p.id}`} p={p} showPrice={scene.banner_show_price} hot={p.id === hotId} />
        ))}
      </div>
    </div>
  );
}

/** Big product photos across the top of the frame. "scroll": they slide past continuously;
 * "slide": one at a time. While a Chibi shows a product the banner can switch to just that one. */
function ProductBanner({ engine, scene, showcase, nickname }: { engine: GameEngine; scene: SceneConfig; showcase: ProductInfo | null; nickname: string | null }) {
  const [i, setI] = useState(0);
  const list = engine.bannerProducts();
  const focus = !!showcase && (scene.banner_focus_on_show || list.length === 0);
  const scrolling = scene.banner_mode === "scroll" && !focus && list.length > 0;
  useEffect(() => {
    if (focus || scrolling) return;
    const id = setInterval(() => setI((x) => x + 1), scene.banner_seconds * 1000);
    return () => clearInterval(id);
  }, [scene.banner_seconds, focus, scrolling]);
  const herbal = scene.theme === "herbal";
  const tv = scene.banner_style === "tv";
  const frame = (mode: string, children: ReactNode, productId?: string) => (
    <div
      className={`product-banner${herbal ? " herbal" : ""}${tv ? " tv" : ""}${showcase ? " showcase" : ""}${mode === "scroll" ? " scrolling" : ""}`}
      style={{ flex: `0 0 ${scene.banner_height * 100}%` }}
      data-testid="product-banner"
      data-mode={mode}
      data-style={tv ? "tv" : "board"}
      data-product-id={productId}
      data-showcase={showcase ? "1" : "0"}
    >
      {tv ? (
        <>
          <span className="tv-cord left" aria-hidden />
          <span className="tv-cord right" aria-hidden />
          <div className="tv-screen">{children}</div>
          <div className="tv-chin" aria-hidden>
            <span className="tv-brand">{scene.sign_text}</span>
            <span className="tv-led" />
          </div>
        </>
      ) : (
        children
      )}
    </div>
  );
  if (scrolling)
    return frame(
      "scroll",
      <>
        <ScrollTrack list={list} scene={scene} hotId={showcase?.id ?? null} />
        {showcase && nickname && <div className="banner-who-tag">👀 {nickname} đang xem {showcase.name}</div>}
      </>,
      showcase?.id,
    );
  const p = focus ? showcase! : list.length ? list[i % list.length] : showcase;
  if (!p) return null;
  const img = p.card_image_url || p.image_url;
  const price = scene.banner_show_price ? formatVnd(p.price) : null;
  return frame(
    focus ? "focus" : "slide",
    <>
      <div className="banner-photo" key={`img-${p.id}`}>
        {img ? <img src={img} alt={p.name} /> : <span className="banner-noimg">🍵</span>}
      </div>
      <div className="banner-body" key={`txt-${p.id}`}>
        {showcase && nickname ? <div className="banner-who">👀 {nickname} đang xem</div> : <div className="banner-shop">{scene.sign_text}</div>}
        <div className="banner-name">{p.name}</div>
        {price && <div className="banner-price">{price}</div>}
        {!focus && list.length > 1 && (
          <div className="banner-dots">
            {list.map((q) => (
              <span key={q.id} className={q.id === p.id ? "on" : ""} />
            ))}
          </div>
        )}
      </div>
    </>,
    p.id,
  );
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
      const b = engine.scene.owner_enabled ? engine.tea.bubble : null;
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
function useOverlayDrag(
  editable: boolean,
  saved: { x: number | null; y: number | null; scale: number },
  msgType: "chibi-board" | "chibi-stage-board" | "chibi-upcoming-board" | "chibi-game-board",
) {
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
      const k = Math.min(1.8, Math.max(0.6, g.scale * (1 + (e.clientX - g.px) / g.w)));
      setDrag({ x: g.x, y: g.y, scale: Math.round(k * 100) / 100 });
    }
  };
  const end = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || !drag) return;
    const msg = { type: msgType, x: Math.round(drag.x * 1000) / 1000, y: Math.round(drag.y * 1000) / 1000, scale: drag.scale };
    if (window.parent !== window) window.parent.postMessage(msg, location.origin);
  };
  const handlers = { onPointerDown: begin("move"), onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  const resizeHandlers = { onPointerDown: begin("size"), onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  /** style for a box placed by hand (null: the box keeps its default spot) */
  const placedStyle: CSSProperties | null = placed
    ? { left: `${placed.x * 100}%`, top: `${placed.y * 100}%`, right: "auto", bottom: "auto", transform: `scale(${scale})`, transformOrigin: "top left" }
    : null;
  return { ref, scale, placedStyle, handlers: editable ? handlers : {}, resizeHandlers };
}

/** “Sắp diễn ra”: what is coming up, soonest first, with live countdowns — and how to join in. */
function UpcomingBoard({ engine, safe, scene, editable }: { engine: GameEngine; safe: SafeArea; scene: SceneConfig; editable: boolean }) {
  const d = useOverlayDrag(editable, { x: scene.upcoming_x, y: scene.upcoming_y, scale: scene.upcoming_scale }, "chibi-upcoming-board");
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
  const d = useOverlayDrag(editable, { x: scene.game_x, y: scene.game_y, scale: scene.game_scale }, "chibi-game-board");
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
  if (!shown) return null;
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
  const d = useOverlayDrag(editable, { x: scene.stage_board_x, y: scene.stage_board_y, scale: scene.stage_board_scale }, "chibi-stage-board");
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
  if (!enabled) return null;
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
            <li key={`${i}-${q.name}`}>{q.name}</li>
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
  const d = useOverlayDrag(editable, { x: scene.board_x, y: scene.board_y, scale: scene.board_scale }, "chibi-board");
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

  const price = st.product ? formatVnd(st.product.price) : null;
  // the LED style lives on the shop's back wall (3D), not over the frame
  const banner = st.scene.banner_enabled && st.scene.banner_style !== "led" && (!!st.product || st.bannerIds !== "");
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
        {st.isDemo && (
          <span className="badge-demo" data-testid="demo-badge">
            DEMO · sự kiện mô phỏng
          </span>
        )}
        {(!socketUp || BAD_STATUSES.has(st.liveStatus)) && (
          <span className="badge-warn" data-testid="status-banner">
            ⚠ {socketUp ? st.liveStatus : "Mất kết nối máy chủ"}
          </span>
        )}
      </div>
      {banner && <ProductBanner engine={engine} scene={st.scene} showcase={st.product} nickname={st.nickname} />}
      {(st.scene.board_enabled || editBoard) && <HonourBoard board={st.board} scene={st.scene} hidden={st.teaShot} editable={editBoard} />}
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
        {speech?.clip && (
          <div
            className={`speech-caption speech-${speech.clip.kind}${speech.held ? " held" : ""}${chatHidden(speech.clip) ? " off-screen" : ""}`}
            data-testid="speech-caption"
            data-kind={speech.clip.kind}
            data-hidden={chatHidden(speech.clip) ? "1" : undefined}
          >
            <span className="speech-label">
              {speech.clip.label === "Trợ lý AI" ? "🤖" : "🔊"} {speech.clip.label}
            </span>
            {/* a poem / story is already in the owner's bubble: the caption only says what is playing */}
            {!((speech.clip.kind === "poem" || speech.clip.kind === "story") && engine.scene.owner_enabled) && <span className="speech-text">{speech.clip.text}</span>}
          </div>
        )}
        {st.product && !banner && (
          <div
            className="product-card"
            data-testid="product-card"
            data-product-id={st.product.id}
          >
            {(st.product.card_image_url || st.product.image_url) && (
              <img
                src={st.product.card_image_url || st.product.image_url!}
                alt={st.product.name}
                className={st.product.card_image_url ? "card-photo" : undefined}
              />
            )}
            <div className="product-card-body">
              {st.nickname && (
                <div className="product-card-who">{st.nickname} đang xem</div>
              )}
              <div className="product-card-name">{st.product.name}</div>
              <div className="product-card-sku">SKU: {st.product.sku}</div>
              {price && <div className="product-card-price">{price}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
