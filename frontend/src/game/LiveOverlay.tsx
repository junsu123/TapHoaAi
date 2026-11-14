// 2D overlay inside the 9:16 frame: product card, DEMO label, connection banner.
// Everything sits inside configurable safe areas so TikTok's own UI never covers it (H4).

import { useEffect, useState, type ReactNode } from "react";
import type { SpeechView } from "./SpeechPlayer";
import { formatVnd } from "../lib/api";
import type { ProductInfo, SceneConfig } from "../types/protocol";
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
  const frame = (mode: string, children: ReactNode, productId?: string) => (
    <div
      className={`product-banner${herbal ? " herbal" : ""}${showcase ? " showcase" : ""}${mode === "scroll" ? " scrolling" : ""}`}
      style={{ flex: `0 0 ${scene.banner_height * 100}%` }}
      data-testid="product-banner"
      data-mode={mode}
      data-product-id={productId}
      data-showcase={showcase ? "1" : "0"}
    >
      {children}
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
          bannerIds: engine.bannerProducts().map((p) => `${p.id}:${p.card_image_url ?? p.image_url}:${p.price}`).join(","),
        };
        return prev.product?.id === next.product?.id &&
          prev.nickname === next.nickname &&
          prev.isDemo === next.isDemo &&
          prev.liveStatus === next.liveStatus &&
          prev.scene === next.scene &&
          prev.bannerIds === next.bannerIds
          ? prev
          : next;
      });
    }, 150);
    return () => clearInterval(id);
  }, [engine]);

  const price = st.product ? formatVnd(st.product.price) : null;
  const banner = st.scene.banner_enabled && (!!st.product || st.bannerIds !== "");
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
