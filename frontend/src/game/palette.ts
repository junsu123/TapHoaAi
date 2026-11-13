import * as THREE from "three";

export const COLORS = {
  floorA: "#fdf1e6",
  floorB: "#f8e3d4",
  wall: "#fde7ef",
  wallTrim: "#f5b7cb",
  shelf: "#f7d9b7",
  shelfEdge: "#e7b98e",
  counter: "#bfe3d5",
  sign: "#ff9cbc",
  ink: "#4a2b3c",
};

const SKIN = ["#ffe0c7", "#f8cfae", "#eab38f", "#d9a07b", "#c68a64"];
const HAIR = ["#3b2a26", "#6b4430", "#c98a4b", "#f2c46d", "#e98bb0", "#8fb6e8", "#2f2f45", "#b07ad9"];
const SHIRT = ["#ffb3c7", "#b8e1ff", "#c7f0c2", "#ffe4a3", "#d9c2ff", "#ffcfa8", "#a8ece4", "#f7a8a8"];
const PANTS = ["#7d8fbf", "#9a7db8", "#6fa3a0", "#c07f95", "#7f7f9c"];

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

const matCache = new Map<string, THREE.Material>();
export function toon(color: string): THREE.Material {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color });
    matCache.set(color, m);
  }
  return m;
}

export const GEO = {
  head: new THREE.SphereGeometry(0.3, 24, 18),
  body: new THREE.CapsuleGeometry(0.17, 0.16, 6, 14),
  arm: new THREE.CapsuleGeometry(0.055, 0.17, 4, 8),
  leg: new THREE.CapsuleGeometry(0.065, 0.1, 4, 8),
  eye: new THREE.SphereGeometry(0.036, 10, 8),
  blush: new THREE.CircleGeometry(0.045, 14),
  bun: new THREE.SphereGeometry(0.11, 12, 10),
  hairCap: new THREE.SphereGeometry(0.315, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.55),
  capBrim: new THREE.CylinderGeometry(0.2, 0.2, 0.03, 18),
  spike: new THREE.ConeGeometry(0.07, 0.16, 8),
  shadow: new THREE.CircleGeometry(0.3, 20),
  box: new THREE.BoxGeometry(1, 1, 1),
};
