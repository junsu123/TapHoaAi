import { createContext } from "react";
import * as THREE from "three";

// Saturated-but-soft "kawaii shop" palette (the first version was too washed out).
export const COLORS = {
  floorPlankA: "#e9b98a",
  floorPlankB: "#dfa977",
  floorLine: "#c48a5c",
  rug: "#ff9ebd",
  rugBorder: "#ffffff",
  wallA: "#ffd6e3",
  wallB: "#ffe7ee",
  wallTrim: "#e2779c",
  baseboard: "#c95f86",
  shelf: "#f4c58f",
  shelfEdge: "#d99a5e",
  counter: "#7fd1b9",
  counterTop: "#ffffff",
  sign: "#ff6f9f",
  ink: "#4a2b3c",
  outline: "#3f2433",
};

const SKIN = ["#ffe0c7", "#f8cfae", "#eab38f", "#d9a07b", "#c68a64"];
const HAIR = ["#3b2a26", "#6b4430", "#c98a4b", "#f2b84b", "#f06fa0", "#5f9be8", "#2f2f45", "#9a5fd6"];
const SHIRT = ["#ff7fa3", "#6cc3ff", "#7fdc8a", "#ffd166", "#b794ff", "#ff9f5a", "#4fd1c5", "#ff6b6b"];
const PANTS = ["#4a5ea8", "#7a5aa8", "#3f8a86", "#b05a7a", "#5a5a7a"];

export interface Appearance {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  hairStyle: 0 | 1 | 2 | 3; // bob, buns, cap, spiky
}

export function appearanceFromSeed(seed: number): Appearance {
  const s = seed >>> 0;
  return {
    skin: SKIN[s % SKIN.length],
    hair: HAIR[(s >>> 3) % HAIR.length],
    shirt: SHIRT[(s >>> 7) % SHIRT.length],
    pants: PANTS[(s >>> 11) % PANTS.length],
    hairStyle: ((s >>> 15) % 4) as Appearance["hairStyle"],
  };
}

// 3-band toon ramp: crisp anime-style shading instead of the default soft 2-tone.
const ramp = (() => {
  const data = new Uint8Array([110, 110, 110, 255, 190, 190, 190, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

const matCache = new Map<string, THREE.Material>();
export function toon(color: string): THREE.Material {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap: ramp });
    matCache.set(color, m);
  }
  return m;
}

/** Inverted-hull outline material: back faces of a slightly larger copy, drawn dark. */
export const OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: COLORS.outline, side: THREE.BackSide });
export const EDGE_MAT = new THREE.LineBasicMaterial({ color: COLORS.outline, transparent: true, opacity: 0.55 });
export const WHITE = new THREE.MeshBasicMaterial({ color: "#ffffff" });

export const GEO = {
  head: new THREE.SphereGeometry(0.3, 40, 28),
  body: new THREE.CapsuleGeometry(0.17, 0.16, 10, 24),
  arm: new THREE.CapsuleGeometry(0.055, 0.17, 6, 12),
  hand: new THREE.SphereGeometry(0.06, 16, 12),
  leg: new THREE.CapsuleGeometry(0.065, 0.1, 6, 12),
  eye: new THREE.SphereGeometry(0.048, 18, 14),
  eyeShine: new THREE.SphereGeometry(0.016, 10, 8),
  mouth: new THREE.TorusGeometry(0.032, 0.008, 6, 16, Math.PI),
  blush: new THREE.CircleGeometry(0.05, 20),
  bun: new THREE.SphereGeometry(0.11, 20, 16),
  hairCap: new THREE.SphereGeometry(0.318, 40, 22, 0, Math.PI * 2, 0, Math.PI * 0.55),
  capBrim: new THREE.CylinderGeometry(0.2, 0.2, 0.03, 28),
  spike: new THREE.ConeGeometry(0.07, 0.16, 12),
  shadow: new THREE.CircleGeometry(0.32, 28),
  box: new THREE.BoxGeometry(1, 1, 1),
};
export const BOX_EDGES = new THREE.EdgesGeometry(GEO.box);

export interface RenderOptions {
  outlines: boolean;
  shadows: boolean;
}
export const RenderContext = createContext<RenderOptions>({ outlines: true, shadows: true });
