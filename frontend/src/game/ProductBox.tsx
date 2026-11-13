// Product box (SPEC H2): the FRONT face shows exactly the approved photo; every other face
// is a neutral colour — we never invent back-of-pack text, ingredients or logos.

import { useContext, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ProductInfo } from "../types/protocol";
import { BOX_EDGES, EDGE_MAT, GEO, RenderContext } from "./palette";

const loader = new THREE.TextureLoader();
const texCache = new Map<string, Promise<THREE.Texture>>();
const NEUTRAL = new THREE.MeshToonMaterial({ color: "#f6f1ea" });

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

const frontCache = new Map<string, THREE.Material>();

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

export function useFrontMaterial(product: ProductInfo | undefined): THREE.Material {
  const key = product ? `${product.id}|${product.image_url}` : "none";
  const [mat, setMat] = useState<THREE.Material>(() => frontCache.get(key) ?? NEUTRAL);
  useEffect(() => {
    if (!product) return;
    const hit = frontCache.get(key);
    if (hit) {
      setMat(hit);
      return;
    }
    let alive = true;
    const done = (tex: THREE.Texture) => {
      const m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      frontCache.set(key, m);
      if (alive) setMat(m);
    };
    if (product.image_url) loadTexture(product.image_url).then(done, () => done(placeholderTexture(product.name)));
    else done(placeholderTexture(product.name));
    return () => {
      alive = false;
    };
  }, [key, product]);
  return mat;
}

export function boxMaterials(front: THREE.Material): THREE.Material[] {
  // BoxGeometry face order: +x, −x, +y, −y, +z (front), −z
  return [NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL, front, NEUTRAL];
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
  const { outlines, shadows } = useContext(RenderContext);
  const [model, setModel] = useState<THREE.Object3D | null>(null);
  const front = useFrontMaterial(product);
  const mats = useMemo(() => boxMaterials(front), [front]);
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
  return (
    <group scale={[s.w, s.h, s.d]}>
      <mesh geometry={GEO.box} material={mats} castShadow={shadows} />
      {outlines && <lineSegments geometry={BOX_EDGES} material={EDGE_MAT} />}
    </group>
  );
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
