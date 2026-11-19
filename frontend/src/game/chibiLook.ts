// The Chibis' look (v0.31): bigger on screen, an anime-style painted face with expressions,
// a fringe of hair, shoes, a soft rim light and a soft round shadow. Everything here is shared
// between all Chibis (textures and materials are cached per colour / expression), so a full
// shop of 60 viewers costs a handful of textures and no extra shader programs per Chibi.

import * as THREE from "three";
import { GEO_LOW } from "./palette";

/** How much bigger than the first (1.1 m tall) Chibis they are drawn. Game logic (paths, slots,
 *  seats) is unchanged: only the drawn body, its name label and the camera framing follow this. */
export const CHIBI_SCALE = 1.45;

// ---------------------------------------------------------------- colours
export const EYE_COLOURS = ["#6b3f26", "#2f2a44", "#9a6324", "#2f7a72", "#7a4fb0"];
export const SHOE_COLOURS = ["#4a3030", "#f4efe6", "#d2493f", "#3d4f86", "#6b4a2e"];

/** Mix a hex colour towards black (k < 0) or white (k > 0). */
export function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  const to = k < 0 ? new THREE.Color(0, 0, 0) : new THREE.Color(1, 1, 1);
  c.lerp(to, Math.min(1, Math.abs(k)));
  return `#${c.getHexString()}`;
}

// ---------------------------------------------------------------- rim-lit toon material
// Softer 3-band ramp than the shop's (Chibis read as rounder, less muddy in the shadow band).
const chibiRamp = (() => {
  const data = new Uint8Array([158, 158, 158, 255, 226, 226, 226, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

/** Adds a warm rim light (fresnel) to a toon material: the silhouette glows a little, so Chibis
 *  stand out from the floor and shelves even in the small overview picture. */
function addRim(m: THREE.MeshToonMaterial, strength = 0.32): THREE.MeshToonMaterial {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <opaque_fragment>",
      `{
        float rimK = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
        outgoingLight += vec3(1.0, 0.94, 0.86) * smoothstep(0.58, 0.92, rimK) * ${strength.toFixed(2)};
      }
      #include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => `chibiRim${strength}`;
  return m;
}

const matCache = new Map<string, THREE.Material>();
/** Rim-lit toon material for a Chibi body part (cached per colour). */
export function chibiMat(color: string): THREE.Material {
  let m = matCache.get(color);
  if (!m) {
    m = addRim(new THREE.MeshToonMaterial({ color, gradientMap: chibiRamp }));
    matCache.set(color, m);
  }
  return m;
}

// ---------------------------------------------------------------- geometry
const HEAD_R = 0.3;
// the painted face is a thin shell just in front of the head's skin
const FACE_PHI = 1.7; // radians across
const FACE_TH0 = 1.0; // from the top of the head
const FACE_TH = 1.25; // radians down
// the fringe: a shell over the forehead, centred like the hair cap
const BANG_PHI = 2.6;
const BANG_TH0 = 0.45;
const BANG_TH = 1.4;
export const BANG_OFFSET: [number, number, number] = [0, 0.02, -0.01];

const faceGeo = (w: number, h: number) =>
  new THREE.SphereGeometry(HEAD_R + 0.003, w, h, Math.PI / 2 - FACE_PHI / 2, FACE_PHI, FACE_TH0, FACE_TH);
const bangsGeo = (w: number, h: number) =>
  new THREE.SphereGeometry(0.323, w, h, Math.PI / 2 - BANG_PHI / 2, BANG_PHI, BANG_TH0, BANG_TH);
// the back half of the head (and a little round the sides), from the crown down to the neck
const backHairGeo = (w: number, h: number) => new THREE.SphereGeometry(0.3, w, h, Math.PI - 0.35, Math.PI + 0.7, 0.9, 1.42);

export const LOOK_GEO = {
  face: faceGeo(22, 14),
  bangs: bangsGeo(28, 10),
  shoe: new THREE.SphereGeometry(0.078, 14, 9),
  hips: new THREE.CylinderGeometry(0.176, 0.182, 0.085, 20),
  backHair: backHairGeo(20, 10),
  badge: new THREE.CircleGeometry(0.034, 16),
};
// low-poly twins for far-away Chibis (same angles, so the painted textures still fit)
GEO_LOW.set(LOOK_GEO.face, faceGeo(10, 6));
GEO_LOW.set(LOOK_GEO.bangs, bangsGeo(12, 5));
GEO_LOW.set(LOOK_GEO.shoe, new THREE.SphereGeometry(0.078, 7, 5));
GEO_LOW.set(LOOK_GEO.hips, new THREE.CylinderGeometry(0.176, 0.182, 0.085, 9));
GEO_LOW.set(LOOK_GEO.backHair, backHairGeo(9, 5));

// ---------------------------------------------------------------- soft blob shadow
let shadowTex: THREE.CanvasTexture | null = null;
export function shadowTexture(): THREE.CanvasTexture {
  if (shadowTex) return shadowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.75)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}
const shadowMats = new Map<string, THREE.Material>();
export function shadowMat(color: string, opacity: number): THREE.Material {
  const k = `${color}|${opacity}`;
  let m = shadowMats.get(k);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, map: shadowTexture(), transparent: true, opacity, depthWrite: false });
    shadowMats.set(k, m);
  }
  return m;
}

// ---------------------------------------------------------------- painted face
export type Eyes = "open" | "closed" | "happy" | "wide";
export type Mouth = "smile" | "grin" | "o" | "yawn";
export interface Expression {
  eyes: Eyes;
  mouth: Mouth;
}

const FW = 512;
const FH = 384;
/** canvas x for a horizontal angle from the middle of the face (radians, + = Chibi's left = viewer's right) */
const fu = (a: number) => (0.5 + a / FACE_PHI) * FW;
/** canvas y for a height on the head (metres, head centre = 0) */
const fv = (y: number) => ((Math.acos(THREE.MathUtils.clamp(y / HEAD_R, -1, 1)) - FACE_TH0) / FACE_TH) * FH;

const INK = "#2b1a22";

function drawOpenEye(g: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, iris: string, side: number, wide: boolean) {
  const rx = w / 2;
  const ry = h / 2;
  // white of the eye
  g.save();
  g.beginPath();
  g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = "#fffdfb";
  g.fill();
  g.clip();
  // big iris: dark on top, bright towards the bottom (the anime "glow")
  const ir = wide ? 0.72 : 0.86;
  const irx = rx * ir;
  const iry = ry * (wide ? 0.74 : 0.92);
  const icy = cy + ry * 0.1;
  const grad = g.createLinearGradient(cx, icy - iry, cx, icy + iry);
  grad.addColorStop(0, shade(iris, -0.6));
  grad.addColorStop(0.5, iris);
  grad.addColorStop(1, shade(iris, 0.5));
  g.beginPath();
  g.ellipse(cx, icy, irx, iry, 0, 0, Math.PI * 2);
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = shade(iris, -0.65);
  g.stroke();
  // pupil
  g.beginPath();
  g.ellipse(cx, icy - iry * 0.05, irx * 0.46, iry * 0.5, 0, 0, Math.PI * 2);
  g.fillStyle = shade(iris, -0.78);
  g.fill();
  // soft lower glow inside the iris
  g.beginPath();
  g.ellipse(cx, icy + iry * 0.55, irx * 0.62, iry * 0.26, 0, 0, Math.PI * 2);
  g.fillStyle = "rgba(255,255,255,0.22)";
  g.fill();
  // highlights: a big one top-left, a small one bottom-right (light from the same side for both eyes)
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.ellipse(cx - rx * 0.3, cy - ry * 0.3, rx * 0.27, ry * 0.22, -0.5, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(cx + rx * 0.3, cy + ry * 0.35, rx * 0.12, 0, Math.PI * 2);
  g.fill();
  g.restore();
  // upper lash line, thick, with a little flick at the outer corner
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.lineCap = "round";
  g.lineWidth = 10;
  g.beginPath();
  g.ellipse(cx, cy + 2, rx * 1.04, ry * 1.0, 0, Math.PI * 1.06, Math.PI * 1.94);
  g.stroke();
  const ox = cx + side * rx * 0.98;
  const oy = cy - ry * 0.32;
  g.beginPath();
  g.moveTo(ox - side * 10, oy - 6);
  g.lineTo(ox + side * 16, oy - 16);
  g.lineTo(ox + side * 2, oy + 8);
  g.closePath();
  g.fill();
  // thin lower line
  g.lineWidth = 3;
  g.globalAlpha = 0.55;
  g.beginPath();
  g.ellipse(cx, cy, rx * 0.9, ry * 0.98, 0, Math.PI * 0.3, Math.PI * 0.7);
  g.stroke();
  g.globalAlpha = 1;
}

function drawFace(iris: string, ex: Expression): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = FW;
  c.height = FH;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, FW, FH);
  const eyeY = fv(-0.03);
  const ew = 96;
  const eh = 122;
  // blush with little "///" marks
  for (const s of [-1, 1]) {
    const bx = fu(s * 0.6);
    const by = fv(-0.1);
    g.save();
    g.translate(bx, by);
    g.scale(1.35, 1);
    const grad = g.createRadialGradient(0, 0, 2, 0, 0, 38);
    grad.addColorStop(0, "rgba(255,120,150,0.62)");
    grad.addColorStop(1, "rgba(255,120,150,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, 38, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.strokeStyle = "rgba(226,86,118,0.6)";
    g.lineWidth = 3;
    g.lineCap = "round";
    for (let i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(bx + i * 13 - 4, by + 7);
      g.lineTo(bx + i * 13 + 4, by - 7);
      g.stroke();
    }
  }
  // eyes
  for (const s of [-1, 1]) {
    const cx = fu(s * 0.37);
    g.strokeStyle = INK;
    g.lineCap = "round";
    if (ex.eyes === "open" || ex.eyes === "wide") {
      drawOpenEye(g, cx, eyeY, ew, eh, iris, s, ex.eyes === "wide");
    } else if (ex.eyes === "closed") {
      // relaxed closed eye: a soft downward curve with a tiny lash
      g.lineWidth = 9;
      g.beginPath();
      g.ellipse(cx, eyeY + eh * 0.02, ew * 0.46, eh * 0.2, 0, Math.PI * 0.08, Math.PI * 0.92);
      g.stroke();
    } else {
      // happy "^ ^"
      g.lineWidth = 10;
      g.beginPath();
      g.ellipse(cx, eyeY + eh * 0.2, ew * 0.42, eh * 0.32, 0, Math.PI * 1.12, Math.PI * 1.88);
      g.stroke();
    }
  }
  // mouth
  const mx = fu(0);
  const my = fv(-0.135);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = "#4a1f26";
  if (ex.mouth === "smile") {
    g.lineWidth = 6;
    g.beginPath();
    g.arc(mx, my - 12, 17, Math.PI * 0.18, Math.PI * 0.82);
    g.stroke();
  } else {
    g.beginPath();
    if (ex.mouth === "grin") {
      g.moveTo(mx - 22, my - 8);
      g.quadraticCurveTo(mx, my - 2, mx + 22, my - 8);
      g.quadraticCurveTo(mx + 18, my + 26, mx, my + 26);
      g.quadraticCurveTo(mx - 18, my + 26, mx - 22, my - 8);
    } else if (ex.mouth === "o") {
      g.ellipse(mx, my + 2, 10, 13, 0, 0, Math.PI * 2);
    } else {
      g.ellipse(mx, my + 6, 16, 22, 0, 0, Math.PI * 2);
    }
    g.closePath();
    g.fillStyle = "#8a2f3b";
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = "#ff8b9c";
    g.beginPath();
    g.ellipse(mx, my + (ex.mouth === "grin" ? 26 : 22), 16, 12, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.lineWidth = 4;
    g.stroke();
  }
  return c;
}

const faceMats = new Map<string, THREE.Material>();
/** The painted-face material for one eye colour and expression (shared by every Chibi). */
export function faceMat(iris: string, ex: Expression): THREE.Material {
  const key = `${iris}|${ex.eyes}|${ex.mouth}`;
  let m = faceMats.get(key);
  if (!m) {
    const tex = new THREE.CanvasTexture(drawFace(iris, ex));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    m = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    faceMats.set(key, m);
  }
  return m;
}

/** What a Chibi's face shows for an animation state (plus blinking now and then). */
export function expressionFor(state: string, t: number, seed: number): Expression {
  switch (state) {
    case "celebrate":
    case "dance":
    case "cheer":
    case "spin":
    case "pose":
      return { eyes: "happy", mouth: "grin" };
    case "hold":
    case "show":
    case "wave":
      return { eyes: blink(t, seed) ? "closed" : "open", mouth: "grin" };
    case "surprise":
      return { eyes: "wide", mouth: "o" };
    case "yawn":
      return { eyes: "closed", mouth: "yawn" };
    case "think":
    case "lookup":
      return { eyes: blink(t, seed) ? "closed" : "open", mouth: "o" };
    default:
      return { eyes: blink(t, seed) ? "closed" : "open", mouth: "smile" };
  }
}

/** A short blink every few seconds, each Chibi on its own rhythm. */
export function blink(t: number, seed: number): boolean {
  const period = 3.1 + (seed % 7) * 0.35;
  return (t + (seed % 13) * 0.29) % period < 0.13;
}

// ---------------------------------------------------------------- fringe (bangs)
const BW = 512;
const BH = 256;

function drawBangs(hair: string, pointed: boolean): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = BW;
  c.height = BH;
  const g = c.getContext("2d")!;
  const yOf = (theta: number) => ((theta - BANG_TH0) / BANG_TH) * BH;
  // the lower edge of the hair, as a height (theta) for each angle across the forehead
  const LOCKS = 7;
  const lockW = 1.5 / LOCKS;
  const edge = (a: number) => {
    const aa = Math.abs(a);
    const k = (a + 0.75) / lockW;
    const f = k - Math.floor(k);
    const tip = pointed ? 1 - Math.abs(2 * f - 1) : Math.pow(Math.max(0, 1 - (2 * f - 1) ** 2), 0.55);
    // lock tips: the middle ones a little shorter, so the eyes are never covered
    const tipTh = 1.42 + 0.05 * Math.min(1, aa / 0.7);
    const front = 1.18 + (tipTh - 1.18) * tip;
    const side = THREE.MathUtils.smoothstep(aa, 0.78, 1.0);
    const sideTh = 1.86 - 0.5 * THREE.MathUtils.smoothstep(aa, 1.12, 1.3);
    return front + (sideTh - front) * side;
  };
  const pts: [number, number][] = [];
  for (let i = 0; i <= 220; i++) {
    const u = i / 220;
    const a = (u - 0.5) * BANG_PHI;
    pts.push([u * BW, yOf(edge(a))]);
  }
  g.beginPath();
  g.moveTo(0, 0);
  for (const [x, y] of pts) g.lineTo(x, y);
  g.lineTo(BW, 0);
  g.closePath();
  g.fillStyle = hair;
  g.fill();
  g.save();
  g.clip();
  // strands: thin darker lines running down into each lock
  g.strokeStyle = shade(hair, -0.3);
  g.globalAlpha = 0.55;
  g.lineWidth = 3;
  for (let i = 0; i <= LOCKS * 2; i++) {
    const a = -0.75 + (i / (LOCKS * 2)) * 1.5;
    const x = (0.5 + a / BANG_PHI) * BW;
    g.beginPath();
    g.moveTo(x + a * 30, yOf(0.75));
    g.quadraticCurveTo(x + a * 14, yOf(1.05), x, yOf(edge(a)) - 6);
    g.stroke();
  }
  // the shine ("angel ring"): a light wavy band across the top
  g.globalAlpha = 0.6;
  g.strokeStyle = shade(hair, 0.42);
  g.lineWidth = 9;
  g.lineCap = "round";
  for (let i = 0; i < 5; i++) {
    const x0 = BW * (0.26 + i * 0.11);
    g.beginPath();
    g.moveTo(x0, yOf(0.86));
    g.quadraticCurveTo(x0 + BW * 0.04, yOf(0.8), x0 + BW * 0.075, yOf(0.87));
    g.stroke();
  }
  g.restore();
  // a darker edge along the tips (reads as the cel outline)
  g.globalAlpha = 1;
  g.strokeStyle = shade(hair, -0.5);
  g.lineWidth = 5;
  g.lineJoin = "round";
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.stroke();
  return c;
}

const bangMats = new Map<string, THREE.Material>();
/** The fringe material for one hair colour (rounded locks, or pointed ones for spiky hair). */
export function bangsMat(hair: string, pointed = false): THREE.Material {
  const key = `${hair}|${pointed ? 1 : 0}`;
  let m = bangMats.get(key);
  if (!m) {
    const tex = new THREE.CanvasTexture(drawBangs(hair, pointed));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    m = addRim(new THREE.MeshToonMaterial({ map: tex, gradientMap: chibiRamp, alphaTest: 0.5 }));
    bangMats.set(key, m);
  }
  return m;
}
