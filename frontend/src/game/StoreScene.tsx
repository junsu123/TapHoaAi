import { useMemo } from "react";
import * as THREE from "three";
import type { ProductInfo, ShelfLayout, StoreLayout } from "../types/protocol";
import { COLORS, toon } from "./palette";
import { ProductBoxMesh } from "./ProductBox";

function floorTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = COLORS.floorA;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = COLORS.floorB;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillRect(64, 64, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

function signTexture(text: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = COLORS.sign;
  ctx.beginPath();
  ctx.roundRect(8, 8, 1008, 240, 60);
  ctx.fill();
  ctx.lineWidth = 14;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 120px system-ui, 'Segoe UI', Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 512, 136);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ShelfMesh({ shelf, products }: { shelf: ShelfLayout; products: Map<string, ProductInfo> }) {
  const { x, z, rot, w, d, h } = shelf.transform;
  const boards = [0.08, 0.55, 1.02, 1.49];
  const wood = toon(COLORS.shelf);
  const edge = toon(COLORS.shelfEdge);
  const decorColors = ["#ffd1dc", "#c9f2e4", "#fff1b8", "#dcd0ff"];
  const tag = useMemo(() => tagTexture(shelf.name), [shelf.name]);
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      {/* back panel and sides */}
      <mesh position={[0, h / 2, -d / 2 + 0.03]} material={wood} receiveShadow>
        <boxGeometry args={[w, h, 0.06]} />
      </mesh>
      {[-1, 1].map((sgn) => (
        <mesh key={sgn} position={[(sgn * w) / 2, h / 2, 0]} material={edge} castShadow>
          <boxGeometry args={[0.07, h, d]} />
        </mesh>
      ))}
      {boards.map((y) => (
        <mesh key={y} position={[0, y, 0]} material={edge} receiveShadow castShadow>
          <boxGeometry args={[w, 0.05, d]} />
        </mesh>
      ))}
      {/* decorative jars on the other boards (not products) */}
      {[0.1, 1.04, 1.51].map((y, bi) =>
        [-0.85, -0.3, 0.3, 0.85].map((dx, i) => (
          <mesh key={`${y}-${dx}`} position={[dx, y + 0.12, 0.02]} material={toon(decorColors[(i + bi) % 4])}>
            <cylinderGeometry args={[0.09, 0.09, 0.2, 12]} />
          </mesh>
        )),
      )}
      {/* product slots: the boxes stay on the shelf; avatars carry visual copies */}
      {shelf.slots.map((sl) => {
        const p = sl.product_id ? products.get(sl.product_id) : undefined;
        return p ? (
          <ProductBoxMesh key={sl.code} product={p} position={[sl.local.x, sl.local.y + 0.025, sl.local.z]} />
        ) : null;
      })}
      {/* shelf code tag */}
      <mesh position={[0, h + 0.18, -d / 2 + 0.05]}>
        <planeGeometry args={[0.7, 0.24]} />
        <meshBasicMaterial map={tag} transparent />
      </mesh>
    </group>
  );
}

function tagTexture(text: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 88;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(4, 4, 248, 80, 30);
  ctx.fill();
  ctx.fillStyle = COLORS.ink;
  ctx.font = "700 46px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 46);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function StoreScene({ layout }: { layout: StoreLayout }) {
  const W = layout.store.width;
  const D = layout.store.depth;
  const floorTex = useMemo(() => {
    const t = floorTexture();
    t.repeat.set(W / 2, D / 2);
    return t;
  }, [W, D]);
  const sign = useMemo(() => signTexture("TẠP HÓA CHIBI"), []);
  const products = useMemo(() => new Map(layout.products.map((p) => [p.id, p])), [layout.products]);
  const c = layout.store.counter;
  const wallH = 2.4;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[W, D]} />
        <meshToonMaterial map={floorTex} />
      </mesh>
      {/* back wall + side walls (front side open towards the camera) */}
      <mesh position={[0, wallH / 2, -D / 2]} material={toon(COLORS.wall)}>
        <boxGeometry args={[W, wallH, 0.15]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * W) / 2, wallH / 4, 0]} material={toon(COLORS.wall)}>
          <boxGeometry args={[0.15, wallH / 2, D]} />
        </mesh>
      ))}
      <mesh position={[0, wallH - 0.1, -D / 2 + 0.09]} material={toon(COLORS.wallTrim)}>
        <boxGeometry args={[W, 0.2, 0.05]} />
      </mesh>
      {/* sign board */}
      <mesh position={[0, wallH + 0.55, -D / 2 + 0.12]}>
        <planeGeometry args={[4.6, 1.15]} />
        <meshBasicMaterial map={sign} transparent />
      </mesh>
      {/* checkout counter with register */}
      <group position={[c.x, 0, c.z]}>
        <mesh position={[0, 0.45, 0]} material={toon(COLORS.counter)} castShadow>
          <boxGeometry args={[c.w, 0.9, c.d]} />
        </mesh>
        <mesh position={[0.9, 1.02, 0]} material={toon("#ffffff")}>
          <boxGeometry args={[0.45, 0.25, 0.35]} />
        </mesh>
        <mesh position={[0.9, 1.2, -0.08]} rotation={[-0.4, 0, 0]} material={toon("#9ed7ff")}>
          <boxGeometry args={[0.38, 0.22, 0.03]} />
        </mesh>
      </group>
      {/* door mat */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[layout.store.door.x, 0.005, D / 2 - 0.6]}>
        <planeGeometry args={[2.2, 0.9]} />
        <meshToonMaterial color="#ffc6d6" />
      </mesh>
      {/* plants in corners */}
      {[[-W / 2 + 0.6, -D / 2 + 0.6], [W / 2 - 0.6, -D / 2 + 0.6]].map(([px, pz]) => (
        <group key={px} position={[px, 0, pz]}>
          <mesh position={[0, 0.2, 0]} material={toon("#f2c4a0")}>
            <cylinderGeometry args={[0.2, 0.16, 0.4, 14]} />
          </mesh>
          <mesh position={[0, 0.65, 0]} material={toon("#8fd19e")}>
            <sphereGeometry args={[0.35, 14, 12]} />
          </mesh>
        </group>
      ))}
      {layout.shelves.map((s) => (
        <ShelfMesh key={`${s.code}-${layout.version}`} shelf={s} products={products} />
      ))}
    </group>
  );
}
