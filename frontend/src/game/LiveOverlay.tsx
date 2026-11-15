// 2D overlay inside the 9:16 frame: product card, DEMO label, connection banner.
// Everything sits inside configurable safe areas so TikTok's own UI never covers it (H4).

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SpeechView } from "./SpeechPlayer";
import { formatVnd } from "../lib/api";
import type { LeaderboardView, ProductInfo, SceneConfig } from "../types/protocol";
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

const MEDAL = ["gold", "silver", "bronze"];

/** "Bảng vàng": top gift givers and top buyers, taking turns. */
function HonourBoard({ board, scene, hidden }: { board: LeaderboardView | null; scene: SceneConfig; hidden: boolean }) {
  const [tab, setTab] = useState<"gifts" | "buyers">("gifts");
  useEffect(() => {
    const id = setInterval(() => setTab((t) => (t === "gifts" ? "buyers" : "gifts")), 8000);
    return () => clearInterval(id);
  }, []);
  const rows =
    tab === "gifts"
      ? (board?.gifts ?? []).map((g) => ({ name: g.name, value: g.coins > 0 ? `${g.coins.toLocaleString("vi-VN")} xu` : `${g.gifts} quà` }))
      : (board?.buyers ?? []).map((b) => ({ name: b.name, value: b.amount > 0 ? (formatVnd(b.amount) ?? "") : `${b.items} sản phẩm` }));
  return (
    <div className={`honour-board ${scene.board_position}${hidden ? " away" : ""}`} data-testid="honour-board" data-tab={tab}>
      <div className="hb-head">
        <span className="hb-crown" aria-hidden>
          👑
        </span>
        <span className="hb-title">Bảng vàng</span>
      </div>
      <div className="hb-tabs">
        <span className={tab === "gifts" ? "on" : ""}>Tặng quà</span>
        <span className={tab === "buyers" ? "on" : ""}>Mua hàng</span>
      </div>
      <ol className="hb-list" key={tab}>
        {rows.length === 0 && <li className="hb-empty">{tab === "gifts" ? "Tặng quà để lên bảng vàng!" : "Mua hàng để lên bảng vàng!"}</li>}
        {rows.slice(0, scene.board_size).map((r, i) => (
          <li key={`${r.name}-${i}`}>
            <span className={`hb-rank ${MEDAL[i] ?? ""}`}>{i + 1}</span>
            <span className="hb-name">{r.name}</span>
            <span className="hb-value">{r.value}</span>
          </li>
        ))}
      </ol>
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
          teaShot: engine.tea.cameraOnTable(),
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
      {st.scene.board_enabled && <HonourBoard board={st.board} scene={st.scene} hidden={st.teaShot} />}
      <OwnerBubble engine={engine} />
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
            className={`speech-caption speech-${speech.clip.kind}${speech.held ? " held" : ""}`}
            data-testid="speech-caption"
            data-kind={speech.clip.kind}
          >
            <span className="speech-label">
              {speech.clip.label === "Trợ lý AI" ? "🤖" : "🔊"} {speech.clip.label}
            </span>
            <span className="speech-text">{speech.clip.text}</span>
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
