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

export function nameTexture(name: string, demo: boolean): { texture: THREE.CanvasTexture; aspect: number } {
  const label = sanitizeLabel(name);
  const key = `${label}|${demo}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const font = "700 44px system-ui, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const textW = Math.ceil(ctx.measureText(label).width);
  const padX = 22;
  const badge = demo ? 0 : 0;
  canvas.width = textW + padX * 2 + badge;
  canvas.height = 72;
  ctx.font = font;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  const r = 30;
  ctx.beginPath();
  ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, r);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#f29bb8";
  ctx.stroke();
  ctx.fillStyle = "#4a2b3c";
  ctx.textBaseline = "middle";
  ctx.fillText(label, padX, canvas.height / 2 + 2);
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
