// A big LED screen fixed flat on the back wall of the shop (part of the 3D scene, so it moves
// with the camera and Chibis walk in front of it). Product photos run across it continuously,
// or one at a time; while a Chibi shows a product, the screen shows just that product.

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { formatVnd } from "../lib/api";
import type { ProductInfo, SceneConfig, StoreLayout } from "../types/protocol";
import type { GameEngine } from "./GameEngine";

/** LED panel on the back wall (metres). The wall is raised to fit it. */
export function ledRect(layout: StoreLayout) {
  const W = layout.store.width;
  const w = Math.min(9, W - 3);
  const h = 3.9;
  const bottom = 1.45;
  return { x: 0, y: bottom + h / 2, z: -layout.store.depth / 2 + 0.1, w, h, bottom, top: bottom + h };
}
export const LED_WALL_HEIGHT = 6.25;
export const ledOn = (s: SceneConfig) => s.banner_enabled && s.banner_style === "led";

const PX_H = 600; // texture pixels per LED height
const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImg(url: string): Promise<HTMLImageElement | null> {
  let p = imgCache.get(url);
  if (!p) {
    p = new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = url;
    });
    imgCache.set(url, p);
  }
  return p;
}
const photoOf = (p: ProductInfo) => p.card_image_url || p.image_url || "";

function screenBg(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#173a30");
  g.addColorStop(1, "#0b1a16");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = 800): number {
  let s = size;
  ctx.font = `${weight} ${s}px "Be Vietnam Pro", system-ui, sans-serif`;
  while (ctx.measureText(text).width > maxW && s > 18) {
    s -= 2;
    ctx.font = `${weight} ${s}px "Be Vietnam Pro", system-ui, sans-serif`;
  }
  return s;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function pill(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, size: number, bg: string) {
  ctx.font = `900 ${size}px "Be Vietnam Pro", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + size * 1.1;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, y, w, size * 1.45, size * 0.72);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, y + size * 0.74);
}

function drawImageContain(ctx: CanvasRenderingContext2D, im: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const k = Math.min(w / im.width, h / im.height);
  ctx.drawImage(im, x + (w - im.width * k) / 2, y + (h - im.height * k) / 2, im.width * k, im.height * k);
}

/** One product card in a cell of the running strip. */
function drawCard(ctx: CanvasRenderingContext2D, p: ProductInfo, im: HTMLImageElement | null, x0: number, cellW: number, showPrice: boolean) {
  const pad = 26;
  const x = x0 + pad / 2;
  const y = 36;
  const w = cellW - pad;
  const h = PX_H - 72;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 26);
  ctx.fill();
  const capH = showPrice && p.price != null ? 128 : 78;
  if (im) drawImageContain(ctx, im, x + 18, y + 16, w - 36, h - capH - 22);
  ctx.fillStyle = "#fbf5e6";
  ctx.fillRect(x, y + h - capH, w, capH - 26);
  ctx.beginPath();
  ctx.roundRect(x, y + h - 52, w, 52, [0, 0, 26, 26]);
  ctx.fill();
  ctx.fillStyle = "#2f2414";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  fitText(ctx, p.name, w - 30, 40);
  ctx.fillText(ellipsize(ctx, p.name, w - 30), x + w / 2, y + h - capH + 36);
  const price = showPrice ? formatVnd(p.price) : null;
  if (price) pill(ctx, price, x + w / 2, y + h - 74, 32, "#b84a32");
}

/** The running strip: the list repeated until it is wider than the screen; it loops seamlessly. */
async function buildStrip(list: ProductInfo[], screenPx: number, showPrice: boolean, onDraw: () => void): Promise<{ canvas: HTMLCanvasElement; cellW: number }> {
  const cellW = Math.round(PX_H * 0.74);
  const reps = Math.max(1, Math.ceil((screenPx + cellW) / (cellW * list.length)));
  const cells = Array.from({ length: reps }, () => list).flat();
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(16384, cells.length * cellW);
  canvas.height = PX_H;
  const ctx = canvas.getContext("2d")!;
  const draw = (imgs: Map<string, HTMLImageElement | null>) => {
    screenBg(ctx, canvas.width, canvas.height);
    cells.forEach((p, i) => drawCard(ctx, p, imgs.get(photoOf(p)) ?? null, i * cellW, cellW, showPrice));
    onDraw();
  };
  draw(new Map());
  const imgs = new Map<string, HTMLImageElement | null>();
  await Promise.all(list.map(async (p) => imgs.set(photoOf(p), photoOf(p) ? await loadImg(photoOf(p)) : null)));
  draw(imgs);
  return { canvas, cellW };
}

/** One product, big: photo left, name and price right (slide mode, or a Chibi showing it). */
function drawSingle(canvas: HTMLCanvasElement, p: ProductInfo, im: HTMLImageElement | null, scene: SceneConfig, who: string | null) {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  screenBg(ctx, W, PX_H);
  const photoW = Math.round(W * 0.42);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(40, 36, photoW, PX_H - 72, 28);
  ctx.fill();
  if (im) drawImageContain(ctx, im, 64, 56, photoW - 48, PX_H - 112);
  const tx = 40 + photoW + 60;
  const tw = W - tx - 50;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = who ? "#ffb4a6" : "#9fd3b4";
  fitText(ctx, who ? `${who} đang xem` : scene.sign_text, tw, 44, 700);
  ctx.fillText(ellipsize(ctx, who ? `${who} đang xem` : scene.sign_text, tw), tx, 150);
  ctx.fillStyle = "#ffffff";
  const size = fitText(ctx, p.name, tw, 104, 900);
  ctx.fillText(ellipsize(ctx, p.name, tw), tx, 150 + size + 30);
  const price = scene.banner_show_price ? formatVnd(p.price) : null;
  if (price) {
    ctx.font = `900 76px "Be Vietnam Pro", system-ui, sans-serif`;
    const pw = ctx.measureText(price).width + 80;
    ctx.fillStyle = "#b84a32";
    ctx.beginPath();
    ctx.roundRect(tx, 150 + size + 70, pw, 110, 55);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(price, tx + 40, 150 + size + 125);
  }
}

/** Faint pixel grid, so it reads as an LED panel. */
function gridTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 7, 8, 1);
  ctx.fillRect(7, 0, 1, 8);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  return t;
}

export function LedWall({ engine, layout }: { engine: GameEngine; layout: StoreLayout }) {
  const r = useMemo(() => ledRect(layout), [layout]);
  const scene = engine.scene;
  const screenPx = Math.round(PX_H * (r.w / r.h));
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  const strip = useRef<{ tex: THREE.CanvasTexture; cellW: number; width: number } | null>(null);
  const single = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = screenPx;
    c.height = PX_H;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [screenPx]);
  const grid = useMemo(() => {
    const t = gridTexture();
    t.repeat.set(r.w * 60, r.h * 60);
    return t;
  }, [r]);
  const list = engine.bannerProducts();
  const listKey = list.map((p) => `${p.id}:${photoOf(p)}:${p.price}:${p.name}`).join("|");
  const state = useRef({ mode: "", shownId: "", slideIdx: 0, slideT: 0, offset: 0 });

  // build the running strip whenever the products or the price setting change
  useEffect(() => {
    let alive = true;
    if (!list.length) return;
    const holder: { tex: THREE.CanvasTexture | null } = { tex: null };
    buildStrip(list, screenPx, scene.banner_show_price, () => {
      if (holder.tex) holder.tex.needsUpdate = true;
    }).then(({ canvas, cellW }) => {
      if (!alive) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      tex.repeat.set(screenPx / canvas.width, 1);
      holder.tex = tex;
      strip.current?.tex.dispose();
      strip.current = { tex, cellW, width: canvas.width };
      state.current.mode = ""; // re-pick the texture next frame
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, screenPx, scene.banner_show_price]);
  useEffect(() => () => {
    strip.current?.tex.dispose();
    single.dispose();
    grid.dispose();
  }, [single, grid]);

  useFrame((_, dt) => {
    const st = state.current;
    const sc = engine.showcase();
    const focus = sc && scene.banner_focus_on_show ? sc : null;
    let mode: string;
    if (focus) mode = `focus:${focus.product.id}:${focus.avatar.info.nickname}`;
    else if (scene.banner_mode === "scroll" && strip.current) mode = "scroll";
    else mode = "slide";
    const m = mat.current;
    if (mode === "scroll") {
      if (st.mode !== "scroll") m.map = strip.current!.tex;
      const s = strip.current!;
      st.offset = (st.offset + (dt * (s.cellW / s.width)) / Math.max(1, scene.banner_seconds)) % 1;
      s.tex.offset.x = st.offset;
    } else {
      let p: ProductInfo | undefined;
      let who: string | null = null;
      if (focus) {
        p = focus.product;
        who = focus.avatar.info.nickname;
      } else {
        st.slideT += dt;
        if (st.slideT > scene.banner_seconds) {
          st.slideT = 0;
          st.slideIdx++;
        }
        p = list.length ? list[st.slideIdx % list.length] : undefined;
      }
      const key = p ? `${mode}|${p.id}|${who ?? ""}` : "";
      if (p && (st.mode !== mode || st.shownId !== key)) {
        st.shownId = key;
        drawSingle(single.image as HTMLCanvasElement, p, null, scene, who);
        single.needsUpdate = true;
        const url = photoOf(p);
        if (url)
          loadImg(url).then((im) => {
            if (state.current.shownId === key && im) {
              drawSingle(single.image as HTMLCanvasElement, p!, im, scene, who);
              single.needsUpdate = true;
            }
          });
      }
      if (m.map !== single) m.map = single;
    }
    if (st.mode !== mode) {
      st.mode = mode;
      m.needsUpdate = true;
    }
    engine.led = { mode: mode.split(":")[0], productId: focus?.product.id ?? null };
  });

  return (
    <group position={[r.x, r.y, r.z]}>
      {/* aluminium frame, flush on the wall */}
      <mesh position={[0, 0, -0.01]}>
        <boxGeometry args={[r.w + 0.14, r.h + 0.14, 0.05]} />
        <meshBasicMaterial color="#1b1e1d" />
      </mesh>
      <mesh position={[0, 0, 0.02]}>
        <planeGeometry args={[r.w, r.h]} />
        <meshBasicMaterial ref={mat} color="#ffffff" toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.022]}>
        <planeGeometry args={[r.w, r.h]} />
        <meshBasicMaterial map={grid} transparent opacity={0.5} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
