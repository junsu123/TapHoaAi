// Nickname labels are painted onto a canvas with fillText — viewer text is never parsed as
// HTML (GAME-09: no HTML injection) and many labels stay cheap to render.

import * as THREE from "three";

export const MAX_LABEL = 16;
// control, zero-width and bidi-override characters
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e]", "g");

export function sanitizeLabel(raw: string): string {
  const s = (raw ?? "").replace(CONTROL_CHARS, "").trim();
  if (!s) return "khách";
  const chars = Array.from(s);
  return chars.length <= MAX_LABEL ? s : chars.slice(0, MAX_LABEL - 1).join("") + "…";
}

const cache = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();

/** Level colours: 1 nón lá (green), 2 áo choàng (red), 3 vương miện (gold). */
const LEVEL_COLOURS = ["#e2779c", "#5aa35a", "#d8434c", "#e0a925"];

/** Draws a heart (khách quen: 3+ LIVEs) centred at x, y. */
function heart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.9);
  ctx.bezierCurveTo(x - s * 1.4, y + s * 0.1, x - s * 0.9, y - s * 1.0, x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.9, y - s * 1.0, x + s * 1.4, y + s * 0.1, x, y + s * 0.9);
  ctx.closePath();
  ctx.fill();
}

export function nameTexture(name: string, demo: boolean, level = 0, regular = false): { texture: THREE.CanvasTexture; aspect: number } {
  const label = sanitizeLabel(name);
  const key = `${label}|${demo}|${level}|${regular}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const font = "800 88px system-ui, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const textW = Math.ceil(ctx.measureText(label).width);
  const padX = 44;
  const badge = level > 0 ? 112 : 0; // a round level badge before the name
  const tail = regular ? 84 : 0; // a heart after the name: khách quen
  canvas.width = textW + padX * 2 + badge + tail;
  canvas.height = 144;
  ctx.font = font;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  const r = 60;
  ctx.beginPath();
  ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, r);
  ctx.fill();
  ctx.lineWidth = level > 0 ? 10 : 8;
  ctx.strokeStyle = LEVEL_COLOURS[Math.min(3, level)];
  ctx.stroke();
  if (level > 0) {
    ctx.fillStyle = LEVEL_COLOURS[Math.min(3, level)];
    ctx.beginPath();
    ctx.arc(padX + 40, canvas.height / 2, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 70px system-ui, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(level), padX + 40, canvas.height / 2 + 4);
    ctx.textAlign = "left";
    ctx.font = font;
  }
  ctx.fillStyle = "#4a2b3c";
  ctx.textBaseline = "middle";
  ctx.fillText(label, padX + badge, canvas.height / 2 + 4);
  if (regular) {
    ctx.fillStyle = "#e2365b";
    heart(ctx, padX + badge + textW + 46, canvas.height / 2 + 2, 30);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const out = { texture, aspect: canvas.width / canvas.height };
  if (cache.size > 300) {
    const first = cache.keys().next().value as string;
    cache.get(first)?.texture.dispose();
    cache.delete(first);
  }
  cache.set(key, out);
  return out;
}
