import { useContext, useMemo } from "react";
import * as THREE from "three";
import type { ProductInfo, ShelfLayout, StoreLayout } from "../types/protocol";
import { COLORS, EDGE_MAT, RenderContext, toon } from "./palette";
import { ProductBoxMesh } from "./ProductBox";

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Honey-wood planks with staggered joints. */
function floorTexture(): THREE.Texture {
  return canvasTexture(512, 512, (ctx) => {
    const rows = 8;
    const h = 512 / rows;
    for (let r = 0; r < rows; r++) {
      ctx.fillStyle = r % 2 ? COLORS.floorPlankA : COLORS.floorPlankB;
      ctx.fillRect(0, r * h, 512, h);
      ctx.strokeStyle = "rgba(160,100,60,0.18)";
      ctx.lineWidth = 2;
      for (let g = 0; g < 3; g++) {
        ctx.beginPath();
        const y = r * h + 10 + g * 18;
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(170, y + 6, 340, y - 6, 512, y + 2);
        ctx.stroke();
      }
      ctx.fillStyle = COLORS.floorLine;
      ctx.fillRect(0, r * h, 512, 3);
      const off = (r % 2) * 128;
      for (let x = off; x < 512 + 256; x += 256) ctx.fillRect((x % 512) - 1, r * h, 3, h);
    }
  });
}

function wallTexture(): THREE.Texture {
  return canvasTexture(256, 256, (ctx) => {
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? COLORS.wallA : COLORS.wallB;
      ctx.fillRect(i * 32, 0, 32, 256);
    }
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    for (let y = 16; y < 256; y += 64)
      for (let x = 16; x < 256; x += 64) {
        ctx.beginPath();
        ctx.arc(x + ((y / 64) % 2) * 32, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
  });
}

function signTexture(text: string): THREE.Texture {
  return canvasTexture(
    2048,
    512,
    (ctx) => {
      ctx.fillStyle = COLORS.sign;
      ctx.beginPath();
      ctx.roundRect(16, 16, 2016, 480, 120);
      ctx.fill();
      ctx.lineWidth = 28;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "900 240px system-ui, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(150,30,80,0.45)";
      ctx.shadowOffsetY = 12;
      ctx.fillText(text, 1024, 272);
    },
    false,
  );
}

function tagTexture(text: string): THREE.Texture {
  return canvasTexture(
    512,
    176,
    (ctx) => {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(8, 8, 496, 160, 60);
      ctx.fill();
      ctx.lineWidth = 10;
      ctx.strokeStyle = COLORS.wallTrim;
      ctx.stroke();
      ctx.fillStyle = COLORS.ink;
      ctx.font = "800 96px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 256, 94);
    },
    false,
  );
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_EDGES = new THREE.EdgesGeometry(UNIT_BOX);

/** Box with crisp dark edges (cartoon look). */
function OutlinedBox({ args, position, color, receive = false }: { args: [number, number, number]; position: [number, number, number]; color: string; receive?: boolean }) {
  const { outlines, shadows } = useContext(RenderContext);
  return (
    <group position={position} scale={args}>
      <mesh geometry={UNIT_BOX} material={toon(color)} castShadow={shadows} receiveShadow={receive && shadows} />
      {outlines && <lineSegments geometry={UNIT_EDGES} material={EDGE_MAT} />}
    </group>
  );
}

const JAR_COLORS = ["#ff8fb1", "#6fd3c2", "#ffd166", "#a78bfa", "#7cc6ff", "#ff9f5a"];

function ShelfMesh({ shelf, products }: { shelf: ShelfLayout; products: Map<string, ProductInfo> }) {
  const { x, z, rot, w, d, h } = shelf.transform;
  const { shadows } = useContext(RenderContext);
  const boards = [0.08, 0.55, 1.02, 1.49];
  const tag = useMemo(() => tagTexture(shelf.name), [shelf.name]);
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <OutlinedBox args={[w, h, 0.06]} position={[0, h / 2, -d / 2 + 0.03]} color={COLORS.shelf} receive />
      {[-1, 1].map((sgn) => (
        <OutlinedBox key={sgn} args={[0.08, h + 0.04, d]} position={[(sgn * w) / 2, h / 2, 0]} color={COLORS.shelfEdge} />
      ))}
      {boards.map((y) => (
        <OutlinedBox key={y} args={[w, 0.05, d]} position={[0, y, 0]} color={COLORS.shelfEdge} receive />
      ))}
      {/* decorative jars with lids on the other boards (not products) */}
      {[0.105, 1.045, 1.515].map((y, bi) =>
        [-0.85, -0.3, 0.3, 0.85].map((dx, i) => (
          <group key={`${y}-${dx}`} position={[dx, y + 0.11, 0.02]}>
            <mesh material={toon(JAR_COLORS[(i + bi * 2) % JAR_COLORS.length])} castShadow={shadows}>
              <cylinderGeometry args={[0.085, 0.09, 0.2, 20]} />
            </mesh>
            <mesh material={toon("#ffffff")} position={[0, 0.12, 0]}>
              <cylinderGeometry args={[0.07, 0.07, 0.04, 20]} />
            </mesh>
          </group>
        )),
      )}
      {/* product slots: the boxes stay on the shelf; avatars carry visual copies */}
      {shelf.slots.map((sl) => {
        const p = sl.product_id ? products.get(sl.product_id) : undefined;
        return p ? <ProductBoxMesh key={sl.code} product={p} position={[sl.local.x, sl.local.y + 0.025, sl.local.z]} /> : null;
      })}
      <mesh position={[0, h + 0.22, -d / 2 + 0.05]}>
        <planeGeometry args={[0.72, 0.25]} />
        <meshBasicMaterial map={tag} transparent toneMapped={false} />
      </mesh>
    </group>
  );
}

/** A string of pastel pennant flags along the back wall. */
function Bunting({ width, z, y }: { width: number; z: number; y: number }) {
  const flags = 14;
  return (
    <group position={[0, y, z]}>
      {Array.from({ length: flags }, (_, i) => {
        const t = i / (flags - 1);
        const fx = -width / 2 + 0.4 + t * (width - 0.8);
        const sag = Math.sin(t * Math.PI) * 0.25;
        return (
          <mesh key={i} position={[fx, -sag, 0]} rotation={[0, 0, Math.PI]} material={toon(JAR_COLORS[i % JAR_COLORS.length])}>
            <coneGeometry args={[0.16, 0.34, 3]} />
          </mesh>
        );
      })}
    </group>
  );
}

export function StoreScene({ layout }: { layout: StoreLayout }) {
  const W = layout.store.width;
  const D = layout.store.depth;
  const { shadows } = useContext(RenderContext);
  const floorTex = useMemo(() => {
    const t = floorTexture();
    t.repeat.set(W / 3, D / 3);
    return t;
  }, [W, D]);
  const wallTex = useMemo(() => {
    const t = wallTexture();
    t.repeat.set(W / 2, 1.2);
    return t;
  }, [W]);
  const sideWallTex = useMemo(() => {
    const t = wallTexture();
    t.repeat.set(D / 2, 0.6);
    return t;
  }, [D]);
  const sign = useMemo(() => signTexture("TẠP HÓA CHIBI"), []);
  const products = useMemo(() => new Map(layout.products.map((p) => [p.id, p])), [layout.products]);
  const c = layout.store.counter;
  const wallH = 2.6;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={shadows}>
        <planeGeometry args={[W, D]} />
        <meshToonMaterial map={floorTex} />
      </mesh>
      {/* centre aisle rug */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]} receiveShadow={shadows}>
        <planeGeometry args={[2.3, D - 3.2]} />
        <meshToonMaterial color={COLORS.rugBorder} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]} receiveShadow={shadows}>
        <planeGeometry args={[2.0, D - 3.5]} />
        <meshToonMaterial color={COLORS.rug} />
      </mesh>
      {/* walls: back + low sides (front open to the camera) */}
      <mesh position={[0, wallH / 2, -D / 2]} receiveShadow={shadows}>
        <boxGeometry args={[W + 0.3, wallH, 0.15]} />
        <meshToonMaterial map={wallTex} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * (W + 0.15)) / 2, wallH / 4, 0]} receiveShadow={shadows}>
          <boxGeometry args={[0.15, wallH / 2, D]} />
          <meshToonMaterial map={sideWallTex} />
        </mesh>
      ))}
      <OutlinedBox args={[W + 0.3, 0.18, 0.08]} position={[0, 0.09, -D / 2 + 0.11]} color={COLORS.baseboard} />
      <OutlinedBox args={[W + 0.3, 0.14, 0.08]} position={[0, wallH - 0.07, -D / 2 + 0.11]} color={COLORS.wallTrim} />
      {[-1, 1].map((s) => (
        <OutlinedBox key={s} args={[0.08, 0.14, D]} position={[(s * W) / 2 - s * 0.03, wallH / 2 - 0.07, 0]} color={COLORS.wallTrim} />
      ))}
      <Bunting width={W} z={-D / 2 + 0.2} y={wallH - 0.25} />
      {/* sign board */}
      <mesh position={[0, wallH + 0.62, -D / 2 + 0.12]}>
        <planeGeometry args={[4.8, 1.2]} />
        <meshBasicMaterial map={sign} transparent toneMapped={false} />
      </mesh>
      {/* checkout counter with register */}
      <group position={[c.x, 0, c.z]}>
        <OutlinedBox args={[c.w, 0.86, c.d]} position={[0, 0.43, 0]} color={COLORS.counter} />
        <OutlinedBox args={[c.w + 0.12, 0.08, c.d + 0.12]} position={[0, 0.9, 0]} color={COLORS.counterTop} />
        <OutlinedBox args={[0.45, 0.25, 0.35]} position={[0.9, 1.07, 0]} color="#ffffff" />
        <mesh position={[0.9, 1.28, -0.08]} rotation={[-0.4, 0, 0]} material={toon("#6cc3ff")}>
          <boxGeometry args={[0.38, 0.22, 0.03]} />
        </mesh>
        <mesh position={[-0.9, 1.06, 0]} material={toon("#ffd166")}>
          <sphereGeometry args={[0.12, 20, 16]} />
        </mesh>
      </group>
      {/* door mat */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[layout.store.door.x, 0.008, D / 2 - 0.6]}>
        <planeGeometry args={[2.4, 0.9]} />
        <meshToonMaterial color="#ff8fb1" />
      </mesh>
      {/* plants in the back corners */}
      {[
        [-W / 2 + 0.6, -D / 2 + 0.6],
        [W / 2 - 0.6, -D / 2 + 0.6],
      ].map(([px, pz]) => (
        <group key={px} position={[px, 0, pz]}>
          <mesh position={[0, 0.22, 0]} material={toon("#f2a36b")} castShadow={shadows}>
            <cylinderGeometry args={[0.22, 0.17, 0.44, 20]} />
          </mesh>
          {[
            [0, 0.75, 0, 0.36],
            [0.18, 0.62, 0.1, 0.24],
            [-0.17, 0.65, -0.05, 0.25],
          ].map(([lx, ly, lz, r], i) => (
            <mesh key={i} position={[lx, ly, lz]} material={toon("#5cc98a")} castShadow={shadows}>
              <sphereGeometry args={[r, 20, 16]} />
            </mesh>
          ))}
        </group>
      ))}
      {layout.shelves.map((s) => (
        <ShelfMesh key={`${s.code}-${layout.version}`} shelf={s} products={products} />
      ))}
    </group>
  );
}
