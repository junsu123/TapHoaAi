import { useContext, useMemo } from "react";
import * as THREE from "three";
import type { ProductInfo, SceneConfig, ShelfLayout, StoreLayout } from "../types/protocol";
import { EDGE_MAT, RenderContext, toon } from "./palette";
import { themeOf, type ShopTheme } from "./themes";
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

/** Wood planks with staggered joints. */
function floorTexture(t: ShopTheme): THREE.Texture {
  return canvasTexture(512, 512, (ctx) => {
    const rows = 8;
    const h = 512 / rows;
    for (let r = 0; r < rows; r++) {
      ctx.fillStyle = r % 2 ? t.floorPlankA : t.floorPlankB;
      ctx.fillRect(0, r * h, 512, h);
      ctx.strokeStyle = t.floorGrain;
      ctx.lineWidth = 2;
      for (let g = 0; g < 3; g++) {
        ctx.beginPath();
        const y = r * h + 10 + g * 18;
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(170, y + 6, 340, y - 6, 512, y + 2);
        ctx.stroke();
      }
      ctx.fillStyle = t.floorLine;
      ctx.fillRect(0, r * h, 512, 3);
      const off = (r % 2) * 128;
      for (let x = off; x < 512 + 256; x += 256) ctx.fillRect((x % 512) - 1, r * h, 3, h);
    }
  });
}

function drawLeaf(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(size * 0.5, -size * 0.35, size, 0);
  ctx.quadraticCurveTo(size * 0.5, size * 0.35, 0, 0);
  ctx.fill();
  ctx.restore();
}

function wallTexture(t: ShopTheme): THREE.Texture {
  if (!t.wainscot)
    return canvasTexture(256, 256, (ctx) => {
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = i % 2 ? t.wallA : t.wallB;
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
  // plaster above, bamboo slats below, a few leaf sprigs on the plaster
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = t.wallA;
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = t.wallB;
    for (let i = 0; i < 40; i++) ctx.fillRect((i * 73) % 256, (i * 151) % 140, 6, 3);
    for (const [x, y, a] of [
      [40, 50, -0.5],
      [170, 95, 0.4],
    ] as const) {
      ctx.strokeStyle = "rgba(95,138,74,0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 40 * Math.cos(a), y + 40 * Math.sin(a));
      ctx.stroke();
      for (let k = 0; k < 4; k++) {
        const px = x + k * 10 * Math.cos(a);
        const py = y + k * 10 * Math.sin(a);
        drawLeaf(ctx, px, py, 16, a - 0.9, "rgba(95,138,74,0.5)");
        drawLeaf(ctx, px, py, 16, a + 0.9, "rgba(125,156,69,0.5)");
      }
    }
    const top = 150;
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i % 2 ? t.wainscot! : "#d2b67a";
      ctx.fillRect(i * 16, top, 16, 256 - top);
      ctx.fillStyle = t.wainscotLine;
      ctx.fillRect(i * 16, top, 2, 256 - top);
      ctx.fillRect(i * 16, top + 40 + (i % 3) * 12, 16, 3); // bamboo nodes
    }
    ctx.fillStyle = t.wallTrim;
    ctx.fillRect(0, top - 6, 256, 6);
  });
}

function signTexture(text: string, tagline: string, t: ShopTheme): THREE.Texture {
  return canvasTexture(
    2048,
    512,
    (ctx) => {
      ctx.fillStyle = t.sign;
      ctx.beginPath();
      ctx.roundRect(16, 16, 2016, 480, t.id === "herbal" ? 48 : 120);
      ctx.fill();
      ctx.lineWidth = 28;
      ctx.strokeStyle = t.signBorder;
      ctx.stroke();
      if (t.id === "herbal") {
        // wood grain + leaf corners
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 6;
        for (let y = 70; y < 480; y += 46) {
          ctx.beginPath();
          ctx.moveTo(60, y);
          ctx.bezierCurveTo(700, y + 14, 1300, y - 14, 1990, y + 4);
          ctx.stroke();
        }
        for (const [x, dir] of [
          [120, 1],
          [1928, -1],
        ] as const) {
          drawLeaf(ctx, x, 250, 110, dir > 0 ? -0.5 : Math.PI + 0.5, "#7d9c45");
          drawLeaf(ctx, x, 250, 110, dir > 0 ? 0.5 : Math.PI - 0.5, "#5f8a4a");
        }
      }
      ctx.fillStyle = t.signText;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = t.signShadow;
      ctx.shadowOffsetY = 12;
      const sub = tagline.trim();
      let size = sub ? 200 : 240;
      const font = (px: number) => `900 ${px}px ${t.id === "herbal" ? "Georgia, 'Times New Roman', serif" : "system-ui, 'Segoe UI', Roboto, sans-serif"}`;
      ctx.font = font(size);
      while (ctx.measureText(text).width > 1720 && size > 80) ctx.font = font((size -= 8));
      ctx.fillText(text, 1024, sub ? 210 : 272);
      if (sub) {
        ctx.shadowOffsetY = 6;
        ctx.font = `600 84px system-ui, 'Segoe UI', Roboto, sans-serif`;
        ctx.fillStyle = t.id === "herbal" ? "#e9dcc0" : "#ffffff";
        ctx.fillText(sub, 1024, 390);
      }
    },
    false,
  );
}

function tagTexture(text: string, t: ShopTheme): THREE.Texture {
  return canvasTexture(
    512,
    176,
    (ctx) => {
      ctx.fillStyle = t.id === "herbal" ? "#fbf5e6" : "#ffffff";
      ctx.beginPath();
      ctx.roundRect(8, 8, 496, 160, t.id === "herbal" ? 30 : 60);
      ctx.fill();
      ctx.lineWidth = 10;
      ctx.strokeStyle = t.tagBorder;
      ctx.stroke();
      ctx.fillStyle = t.tagText;
      ctx.font = "800 96px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 256, 94);
    },
    false,
  );
}

const posterCache = new Map<string, THREE.CanvasTexture>();
/** Framed product photo for the back wall; the photo is drawn whole ("contain") once it loads. */
function posterTexture(url: string, t: ShopTheme): THREE.CanvasTexture {
  const key = `${t.id}|${url}`;
  const hit = posterCache.get(key);
  if (hit) return hit;
  const S = 1024;
  const tex = canvasTexture(
    S,
    S,
    (ctx) => {
      ctx.fillStyle = t.id === "herbal" ? "#fbf5e6" : "#ffffff";
      ctx.fillRect(0, 0, S, S);
    },
    false,
  );
  const img = new Image();
  img.onload = () => {
    const ctx = (tex.image as HTMLCanvasElement).getContext("2d")!;
    const pad = 40;
    const k = Math.min((S - pad * 2) / img.width, (S - pad * 2) / img.height);
    const w = img.width * k;
    const h = img.height * k;
    ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
    tex.needsUpdate = true;
  };
  img.src = url;
  posterCache.set(key, tex);
  return tex;
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

function ShelfMesh({ shelf, products, theme }: { shelf: ShelfLayout; products: Map<string, ProductInfo>; theme: ShopTheme }) {
  const { x, z, rot, w, d, h } = shelf.transform;
  const { shadows } = useContext(RenderContext);
  const boards = [0.08, 0.55, 1.02, 1.49];
  const tag = useMemo(() => tagTexture(shelf.name, theme), [shelf.name, theme]);
  const herbal = theme.id === "herbal";
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <OutlinedBox args={[w, h, 0.06]} position={[0, h / 2, -d / 2 + 0.03]} color={theme.shelf} receive />
      {[-1, 1].map((sgn) => (
        <OutlinedBox key={sgn} args={[0.08, h + 0.04, d]} position={[(sgn * w) / 2, h / 2, 0]} color={theme.shelfEdge} />
      ))}
      {boards.map((y) => (
        <OutlinedBox key={y} args={[w, 0.05, d]} position={[0, y, 0]} color={theme.shelfEdge} receive />
      ))}
      {/* decorative jars on the other boards (not products): glass jars of dried herbs / clay pots */}
      {[0.105, 1.045, 1.515].map((y, bi) =>
        [-0.85, -0.3, 0.3, 0.85].map((dx, i) => {
          const color = theme.jars[(i + bi * 2) % theme.jars.length];
          const pot = herbal && (i + bi) % 3 === 2;
          return (
            <group key={`${y}-${dx}`} position={[dx, y + 0.11, 0.02]}>
              {pot ? (
                <>
                  <mesh material={toon("#b5653a")} castShadow={shadows} position={[0, -0.01, 0]}>
                    <sphereGeometry args={[0.11, 18, 14]} />
                  </mesh>
                  <mesh material={toon("#8f4a28")} position={[0, 0.1, 0]}>
                    <cylinderGeometry args={[0.06, 0.07, 0.05, 16]} />
                  </mesh>
                </>
              ) : (
                <>
                  <mesh material={toon(color)} castShadow={shadows}>
                    <cylinderGeometry args={[0.085, 0.09, 0.2, 20]} />
                  </mesh>
                  <mesh material={toon(theme.jarLid)} position={[0, 0.12, 0]}>
                    <cylinderGeometry args={[0.07, 0.07, 0.04, 20]} />
                  </mesh>
                  {herbal && (
                    <mesh material={toon("#fbf5e6")} position={[0, 0, 0.088]}>
                      <boxGeometry args={[0.1, 0.07, 0.005]} />
                    </mesh>
                  )}
                </>
              )}
            </group>
          );
        }),
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

/** A string of pastel pennant flags along the back wall (kawaii theme). */
function Bunting({ width, z, y, colors }: { width: number; z: number; y: number; colors: string[] }) {
  const flags = 14;
  return (
    <group position={[0, y, z]}>
      {Array.from({ length: flags }, (_, i) => {
        const t = i / (flags - 1);
        const fx = -width / 2 + 0.4 + t * (width - 0.8);
        const sag = Math.sin(t * Math.PI) * 0.25;
        return (
          <mesh key={i} position={[fx, -sag, 0]} rotation={[0, 0, Math.PI]} material={toon(colors[i % colors.length])}>
            <coneGeometry args={[0.16, 0.34, 3]} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Round paper lanterns hanging along the back wall (herbal theme). */
function Lanterns({ xs, z, y }: { xs: number[]; z: number; y: number }) {
  return (
    <group position={[0, y, z]}>
      {xs.map((x, i) => (
        <group key={x} position={[x, 0, 0]}>
          <mesh material={toon("#3b2a1a")} position={[0, 0.35, 0]}>
            <cylinderGeometry args={[0.008, 0.008, 0.5, 6]} />
          </mesh>
          <mesh material={toon(i % 2 ? "#e39a35" : "#c8452c")} scale={[1, 1.2, 1]}>
            <sphereGeometry args={[0.2, 20, 14]} />
          </mesh>
          {[-0.25, 0.25].map((dy) => (
            <mesh key={dy} material={toon("#3b2a1a")} position={[0, dy, 0]}>
              <cylinderGeometry args={[0.07, 0.07, 0.04, 14]} />
            </mesh>
          ))}
          <mesh material={toon("#e8c46a")} position={[0, -0.36, 0]}>
            <cylinderGeometry args={[0.02, 0.035, 0.16, 8]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Clump of bamboo in a planter. */
function Bamboo({ position }: { position: [number, number, number] }) {
  const { shadows } = useContext(RenderContext);
  const stalks: [number, number, number][] = [
    [0, 0, 2.5],
    [0.16, 0.08, 2.1],
    [-0.14, 0.1, 2.3],
    [0.05, -0.15, 1.8],
  ];
  return (
    <group position={position}>
      <OutlinedBox args={[0.7, 0.4, 0.7]} position={[0, 0.2, 0]} color="#8d6037" />
      <OutlinedBox args={[0.6, 0.04, 0.6]} position={[0, 0.41, 0]} color="#5d3b22" />
      {stalks.map(([sx, sz, h], i) => (
        <group key={i} position={[sx, 0.4, sz]}>
          <mesh material={toon("#7fae4c")} position={[0, h / 2, 0]} castShadow={shadows}>
            <cylinderGeometry args={[0.035, 0.04, h, 10]} />
          </mesh>
          {Array.from({ length: Math.floor(h / 0.45) }, (_, k) => (
            <mesh key={k} material={toon("#5f8a3a")} position={[0, 0.4 + k * 0.45, 0]}>
              <cylinderGeometry args={[0.045, 0.045, 0.03, 10]} />
            </mesh>
          ))}
          {[0, 1, 2].map((k) => (
            <mesh key={k} material={toon(k % 2 ? "#6f9e3f" : "#8cbf55")} position={[Math.cos(k * 2.1 + i) * 0.16, h - 0.1 - k * 0.25, Math.sin(k * 2.1 + i) * 0.16]} rotation={[0.3, k * 2.1 + i, 1.2]} castShadow={shadows}>
              <coneGeometry args={[0.06, 0.38, 4]} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/** Woven basket of loose herbs. */
function HerbBasket({ position, color }: { position: [number, number, number]; color: string }) {
  const { shadows } = useContext(RenderContext);
  return (
    <group position={position}>
      <mesh material={toon("#c9a46a")} position={[0, 0.17, 0]} castShadow={shadows}>
        <cylinderGeometry args={[0.32, 0.26, 0.34, 20]} />
      </mesh>
      <mesh material={toon("#a8844c")} position={[0, 0.34, 0]}>
        <torusGeometry args={[0.32, 0.03, 8, 24]} />
      </mesh>
      <mesh material={toon(color)} position={[0, 0.33, 0]} scale={[1, 0.35, 1]}>
        <sphereGeometry args={[0.3, 18, 12]} />
      </mesh>
    </group>
  );
}

/** Clay teapot and cups on a tray. */
function TeaSet({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <OutlinedBox args={[0.9, 0.04, 0.45]} position={[0, 0.02, 0]} color="#3b2a1a" />
      <group position={[-0.18, 0.15, 0]}>
        <mesh material={toon("#8b4a2b")} scale={[1, 0.8, 1]}>
          <sphereGeometry args={[0.14, 20, 14]} />
        </mesh>
        <mesh material={toon("#8b4a2b")} position={[0.17, 0.02, 0]} rotation={[0, 0, -0.9]}>
          <cylinderGeometry args={[0.018, 0.03, 0.14, 8]} />
        </mesh>
        <mesh material={toon("#6e3a20")} position={[0, 0.12, 0]}>
          <sphereGeometry args={[0.04, 10, 8]} />
        </mesh>
        <mesh material={toon("#6e3a20")} position={[-0.15, 0.02, 0]} rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.06, 0.015, 6, 14, Math.PI]} />
        </mesh>
      </group>
      {[0.12, 0.26].map((cx) => (
        <mesh key={cx} material={toon("#f3ead6")} position={[cx, 0.08, 0.05]}>
          <cylinderGeometry args={[0.045, 0.035, 0.07, 14]} />
        </mesh>
      ))}
    </group>
  );
}

/** Framed photo of a product on the back wall. */
function Poster({ product, theme, position, size }: { product: ProductInfo; theme: ShopTheme; position: [number, number, number]; size: number }) {
  const url = product.card_image_url || product.image_url || "";
  const tex = useMemo(() => posterTexture(url, theme), [url, theme]);
  return (
    <group position={position}>
      <OutlinedBox args={[size + 0.14, size + 0.14, 0.05]} position={[0, 0, 0]} color={theme.id === "herbal" ? "#5d3b22" : theme.wallTrim} />
      <mesh position={[0, 0, 0.03]}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function StoreScene({ layout, scene, posters }: { layout: StoreLayout; scene: SceneConfig; posters: ProductInfo[] }) {
  const theme = themeOf(scene.theme);
  const herbal = theme.id === "herbal";
  const W = layout.store.width;
  const D = layout.store.depth;
  const { shadows } = useContext(RenderContext);
  const wallH = theme.wallHeight;
  const floorTex = useMemo(() => {
    const t = floorTexture(theme);
    t.repeat.set(W / 3, D / 3);
    return t;
  }, [W, D, theme]);
  const wallTex = useMemo(() => {
    const t = wallTexture(theme);
    t.repeat.set(W / 2, herbal ? 1 : 1.2);
    return t;
  }, [W, theme, herbal]);
  const sideWallTex = useMemo(() => {
    const t = wallTexture(theme);
    t.repeat.set(D / 2, herbal ? 1 : 0.6);
    return t;
  }, [D, theme, herbal]);
  const sign = useMemo(
    () => signTexture(scene.sign_text || "TIỆM TRÀ THẢO MỘC", herbal ? scene.tagline : "", theme),
    [scene.sign_text, scene.tagline, theme, herbal],
  );
  const products = useMemo(() => new Map(layout.products.map((p) => [p.id, p])), [layout.products]);
  const c = layout.store.counter;
  const sideH = herbal ? wallH * 0.42 : wallH / 2;
  const shown = scene.wall_posters ? posters.slice(0, 2) : [];
  const posterSize = 1.15;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={shadows}>
        <planeGeometry args={[W, D]} />
        <meshToonMaterial map={floorTex} />
      </mesh>
      {/* centre aisle rug / woven mat */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]} receiveShadow={shadows}>
        <planeGeometry args={[2.3, D - 3.2]} />
        <meshToonMaterial color={theme.rugBorder} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]} receiveShadow={shadows}>
        <planeGeometry args={[2.0, D - 3.5]} />
        <meshToonMaterial color={theme.rug} />
      </mesh>
      {herbal &&
        Array.from({ length: Math.floor((D - 3.6) / 0.5) }, (_, i) => (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.007, -(D - 3.5) / 2 + 0.25 + i * 0.5]}>
            <planeGeometry args={[2.0, 0.04]} />
            <meshBasicMaterial color="#c4a96f" />
          </mesh>
        ))}
      {/* walls: back + low sides (front open to the camera) */}
      <mesh position={[0, wallH / 2, -D / 2]} receiveShadow={shadows}>
        <boxGeometry args={[W + 0.3, wallH, 0.15]} />
        <meshToonMaterial map={wallTex} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * (W + 0.15)) / 2, sideH / 2, 0]} receiveShadow={shadows}>
          <boxGeometry args={[0.15, sideH, D]} />
          <meshToonMaterial map={sideWallTex} />
        </mesh>
      ))}
      <OutlinedBox args={[W + 0.3, 0.18, 0.08]} position={[0, 0.09, -D / 2 + 0.11]} color={theme.baseboard} />
      <OutlinedBox args={[W + 0.3, 0.14, 0.08]} position={[0, wallH - 0.07, -D / 2 + 0.11]} color={theme.wallTrim} />
      {[-1, 1].map((s) => (
        <OutlinedBox key={s} args={[0.08, 0.14, D]} position={[(s * W) / 2 - s * 0.03, sideH - 0.07, 0]} color={theme.wallTrim} />
      ))}
      {herbal ? (
        <Lanterns xs={[-W / 2 + 1.1, -2.6, 2.6, W / 2 - 1.1]} z={-D / 2 + 0.45} y={wallH - 0.6} />
      ) : (
        <Bunting width={W} z={-D / 2 + 0.2} y={wallH - 0.25} colors={theme.jars} />
      )}
      {/* sign board */}
      <mesh position={[0, wallH + 0.62, -D / 2 + 0.12]}>
        <planeGeometry args={[herbal ? 5.6 : 4.8, herbal ? 1.4 : 1.2]} />
        <meshBasicMaterial map={sign} transparent toneMapped={false} />
      </mesh>
      {/* product posters on the back wall, behind the counter */}
      {shown.map((p, i) => (
        <Poster
          key={p.id}
          product={p}
          theme={theme}
          size={posterSize}
          position={[shown.length === 1 ? 0 : (i === 0 ? -1 : 1) * (posterSize / 2 + 0.2), wallH - posterSize / 2 - 0.35, -D / 2 + 0.1]}
        />
      ))}
      {/* checkout / tea counter */}
      <group position={[c.x, 0, c.z]}>
        <OutlinedBox args={[c.w, 0.86, c.d]} position={[0, 0.43, 0]} color={theme.counter} />
        <OutlinedBox args={[c.w + 0.12, 0.08, c.d + 0.12]} position={[0, 0.9, 0]} color={theme.counterTop} />
        {herbal ? (
          <>
            {[-1, -0.33, 0.33, 1].map((dx) => (
              <OutlinedBox key={dx} args={[0.04, 0.7, 0.02]} position={[dx * (c.w / 2 - 0.25), 0.43, c.d / 2 + 0.01]} color="#6b4424" />
            ))}
            <TeaSet position={[0.75, 0.94, 0]} />
            <group position={[-0.9, 0.94, 0]}>
              {[0, 1, 2].map((k) => (
                <mesh key={k} material={toon(theme.jars[k])} position={[k * 0.22 - 0.22, 0.12, 0]}>
                  <cylinderGeometry args={[0.08, 0.08, 0.24, 16]} />
                </mesh>
              ))}
            </group>
          </>
        ) : (
          <>
            <OutlinedBox args={[0.45, 0.25, 0.35]} position={[0.9, 1.07, 0]} color="#ffffff" />
            <mesh position={[0.9, 1.28, -0.08]} rotation={[-0.4, 0, 0]} material={toon("#6cc3ff")}>
              <boxGeometry args={[0.38, 0.22, 0.03]} />
            </mesh>
            <mesh position={[-0.9, 1.06, 0]} material={toon("#ffd166")}>
              <sphereGeometry args={[0.12, 20, 16]} />
            </mesh>
          </>
        )}
      </group>
      {/* door mat */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[layout.store.door.x, 0.008, D / 2 - 0.6]}>
        <planeGeometry args={[2.4, 0.9]} />
        <meshToonMaterial color={theme.doorMat} />
      </mesh>
      {herbal ? (
        <>
          <Bamboo position={[-W / 2 + 0.55, 0, -D / 2 + 0.55]} />
          <Bamboo position={[W / 2 - 0.55, 0, -D / 2 + 0.55]} />
          <HerbBasket position={[c.x - c.w / 2 - 0.55, 0, c.z + 0.1]} color="#7d9c45" />
          <HerbBasket position={[c.x + c.w / 2 + 0.55, 0, c.z + 0.1]} color="#e2b437" />
          <HerbBasket position={[-W / 2 + 0.55, 0, D / 2 - 1.2]} color="#b84a32" />
          <HerbBasket position={[W / 2 - 0.55, 0, D / 2 - 1.2]} color="#7d9c45" />
        </>
      ) : (
        [
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
        ))
      )}
      {layout.shelves.map((s) => (
        <ShelfMesh key={`${s.code}-${layout.version}`} shelf={s} products={products} theme={theme} />
      ))}
    </group>
  );
}
