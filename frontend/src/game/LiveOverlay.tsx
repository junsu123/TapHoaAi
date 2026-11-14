// 2D overlay inside the 9:16 frame: product card, DEMO label, connection banner.
// Everything sits inside configurable safe areas so TikTok's own UI never covers it (H4).

import { useEffect, useState } from "react";
import { formatVnd } from "../lib/api";
import type { ProductInfo } from "../types/protocol";
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
}

const BAD_STATUSES = new Set(["Mất kết nối", "Đã kết thúc", "Không hỗ trợ", "Không phát LIVE"]);

export function LiveOverlay({ engine, safe, socketUp }: { engine: GameEngine; safe: SafeArea; socketUp: boolean }) {
  const [st, setSt] = useState<OverlayState>({ product: null, nickname: null, isDemo: false, liveStatus: "" });
  useEffect(() => {
    const id = setInterval(() => {
      const sc = engine.showcase();
      setSt((prev) => {
        const next = {
          product: sc?.product ?? null,
          nickname: sc?.avatar.info.nickname ?? null,
          isDemo: engine.isDemo,
          liveStatus: engine.liveStatus,
        };
        return prev.product?.id === next.product?.id &&
          prev.nickname === next.nickname &&
          prev.isDemo === next.isDemo &&
          prev.liveStatus === next.liveStatus
          ? prev
          : next;
      });
    }, 150);
    return () => clearInterval(id);
  }, [engine]);

  const price = st.product ? formatVnd(st.product.price) : null;
  return (
    <div
      className="overlay"
      style={{ paddingTop: `${safe.top * 100}%`, paddingBottom: `${safe.bottom * 100}%`, paddingRight: `${safe.right * 100}%`, paddingLeft: `${safe.left * 100}%` }}
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
      {st.product && (
        <div className="product-card" data-testid="product-card" data-product-id={st.product.id}>
          {(st.product.card_image_url || st.product.image_url) && (
            <img
              src={st.product.card_image_url || st.product.image_url!}
              alt={st.product.name}
              className={st.product.card_image_url ? "card-photo" : undefined}
            />
          )}
          <div className="product-card-body">
            {st.nickname && <div className="product-card-who">{st.nickname} đang xem</div>}
            <div className="product-card-name">{st.product.name}</div>
            <div className="product-card-sku">SKU: {st.product.sku}</div>
            {price && <div className="product-card-price">{price}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
