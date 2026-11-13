// Product box (SPEC H2): the FRONT face shows exactly the approved photo; every other face
// is a neutral colour — we never invent back-of-pack text, ingredients or logos.

import { useContext, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
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

export function ProductBoxMesh({ product, position }: { product: ProductInfo; position?: [number, number, number] }) {
  const front = useFrontMaterial(product);
  const mats = useMemo(() => boxMaterials(front), [front]);
  const s = product.box_size;
  const { outlines, shadows } = useContext(RenderContext);
  return (
    <group position={position}>
      <group scale={[s.w, s.h, s.d]} position={[0, s.h / 2, 0]}>
        <mesh geometry={GEO.box} material={mats} castShadow={shadows} />
        {outlines && <lineSegments geometry={BOX_EDGES} material={EDGE_MAT} />}
      </group>
    </group>
  );
}
