// Product box (SPEC H2): the FRONT face shows exactly the approved photo; every other face
// is a neutral colour — we never invent back-of-pack text, ingredients or logos.

import { useContext, useEffect, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ProductInfo } from "../types/protocol";
import { RenderContext } from "./palette";

const loader = new THREE.TextureLoader();
const texCache = new Map<string, Promise<THREE.Texture>>();

export function loadTexture(url: string): Promise<THREE.Texture> {
  let p = texCache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    });
    texCache.set(url, p);
  }
  return p;
}

function placeholderTexture(name: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 200;
  c.height = 280;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 200, 280);
  ctx.fillStyle = "#9a8790";
  ctx.font = "600 20px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Chưa có ảnh", 100, 120);
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(name.slice(0, 18), 100, 150);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- realistic package box
// BoxGeometry material order: +x (right), −x (left), +y (top), −y (bottom), +z (front), −z (back)
const FACE_ORDER = ["right", "left", "top", "bottom", "front", "back"] as const;
type Face = (typeof FACE_ORDER)[number];
const DEFAULT_BOX_COLOR = "#f6f1ea";

/** Lit, slightly satin card-board: reacts to the scene lights like a real printed box. */
function cardboard(map: THREE.Texture | null, color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map, color: map ? "#ffffff" : color, roughness: 0.5, metalness: 0 });
}

const boxMatCache = new Map<string, THREE.Material[]>();

function faceUrl(product: ProductInfo, face: Face): string | null {
  if (face === "front") return product.image_url ?? null;
  return product.face_urls?.[face] ?? null;
}

/** Six materials for the product box: approved photos where given, the box colour elsewhere.
 *  Never invents package content: a face without an approved photo is plain colour. */
export function useBoxMaterials(product: ProductInfo | undefined): THREE.Material[] {
  const color = product?.box_color || DEFAULT_BOX_COLOR;
  const key = product ? [product.id, color, ...FACE_ORDER.map((f) => faceUrl(product, f) ?? "-")].join("|") : "none";
  const [mats, setMats] = useState<THREE.Material[]>(() => boxMatCache.get(key) ?? FACE_ORDER.map(() => cardboard(null, color)));
  useEffect(() => {
    if (!product) return;
    const hit = boxMatCache.get(key);
    if (hit) {
      setMats(hit);
      return;
    }
    let alive = true;
    Promise.all(
      FACE_ORDER.map((f) => {
        const url = faceUrl(product, f);
        if (!url) return Promise.resolve(f === "front" ? placeholderTexture(product.name) : null);
        return loadTexture(url).catch(() => (f === "front" ? placeholderTexture(product.name) : null));
      }),
    ).then((textures) => {
      const built = textures.map((t) => cardboard(t, color));
      boxMatCache.set(key, built);
      if (alive) setMats(built);
    });
    return () => {
      alive = false;
    };
  }, [key, product, color]);
  return mats;
}

const roundedCache = new Map<string, THREE.BufferGeometry>();
/** Real boxes have softly folded edges; a 3–4 mm radius at real scale reads as cardboard. */
function roundedBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = `${w}|${h}|${d}`;
  let g = roundedCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 3, Math.min(w, h, d) * 0.07);
    roundedCache.set(key, g);
  }
  return g;
}

// ---------------------------------------------------------------- GLB models (GAME-06)
const gltfLoader = new GLTFLoader();
const modelCache = new Map<string, Promise<THREE.Object3D>>();
/** Debug view of model loading for tests: url → "loading" | "loaded" | "error". */
export const modelStatus: Record<string, string> = {};
(globalThis as unknown as { __chibiModels?: object }).__chibiModels = modelStatus;

function loadModel(url: string): Promise<THREE.Object3D> {
  let p = modelCache.get(url);
  if (!p) {
    modelStatus[url] = "loading";
    p = gltfLoader.loadAsync(url).then(
      (g) => {
        modelStatus[url] = "loaded";
        return g.scene;
      },
      (e) => {
        modelStatus[url] = "error";
        throw e;
      },
    );
    modelCache.set(url, p);
  }
  return p;
}

/** Clone of the model, uniformly scaled to fit inside the product's real size, centred. */
function fittedClone(src: THREE.Object3D, size: { w: number; h: number; d: number }): THREE.Object3D {
  const clone = src.clone(true);
  const box = new THREE.Box3().setFromObject(clone);
  const dim = box.getSize(new THREE.Vector3());
  // keep the model's own proportions: match the product's height, and keep its footprint
  // no wider than the photo box's widest side (a round tin must not be squeezed to the box depth)
  const k = Math.min(size.h / (dim.y || 1), (1.2 * Math.max(size.w, size.d)) / (Math.max(dim.x, dim.z) || 1));
  const center = box.getCenter(new THREE.Vector3());
  const wrapper = new THREE.Group();
  clone.position.sub(center);
  wrapper.add(clone);
  wrapper.scale.setScalar(k);
  return wrapper;
}

/**
 * The product as seen in the game, centred on the origin at real size: the approved GLB
 * when there is one, otherwise (or while loading / if it fails) the photo box.
 */
export function ProductVisual({ product }: { product: ProductInfo }) {
  const { shadows } = useContext(RenderContext);
  const [model, setModel] = useState<THREE.Object3D | null>(null);
  const mats = useBoxMaterials(product);
  const url = product.model_url ?? null;
  useEffect(() => {
    setModel(null);
    if (!url) return;
    let alive = true;
    loadModel(url).then(
      (scene) => alive && setModel(fittedClone(scene, product.box_size)),
      () => undefined, // keep the photo box: a broken model must never block the action
    );
    return () => {
      alive = false;
    };
  }, [url, product.box_size]);
  if (model) return <primitive object={model} />;
  const s = product.box_size;
  return <mesh geometry={roundedBox(s.w, s.h, s.d)} material={mats} castShadow={shadows} receiveShadow={shadows} />;
}

export function ProductBoxMesh({ product, position }: { product: ProductInfo; position?: [number, number, number] }) {
  return (
    <group position={position}>
      <group position={[0, product.box_size.h / 2, 0]}>
        <ProductVisual product={product} />
      </group>
    </group>
  );
}
