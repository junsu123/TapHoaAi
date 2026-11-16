import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { reportError } from "../lib/errorReporter";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ChibiAvatar } from "./ChibiAvatar";
import type { GameEngine } from "./GameEngine";
import { layoutLabels, type LabelBox } from "./labelLayout";
import { LabelRegistryContext, RenderContext, type LabelEntry } from "./palette";
import { LedWall, ledOn } from "./LedWall";
import { StoreScene } from "./StoreScene";
import { TeaCorner } from "./TeaCorner";
import { DebugProjector } from "./BehaviorDebugOverlay";
import { themeOf } from "./themes";
import { LOD, lodPolicy } from "./lod";
import type { PerfReport } from "../types/protocol";

export type Quality = "low" | "medium" | "high";

/** Render at the screen's real pixel density (never below 1×) — the old 1×/0.6× made it blurry. */
const deviceDpr = () => Math.max(1, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
export const QUALITY: Record<Quality, { dpr: number; shadows: boolean; shadowMap: number; outlines: boolean }> = {
  low: { dpr: 1, shadows: false, shadowMap: 512, outlines: false },
  medium: { dpr: Math.min(deviceDpr(), 1.5), shadows: true, shadowMap: 1024, outlines: true },
  high: { dpr: Math.min(deviceDpr(), 2), shadows: true, shadowMap: 2048, outlines: true },
};

const OVERVIEW_POS = new THREE.Vector3(0, 17.5, 12.2);
const OVERVIEW_LOOK = new THREE.Vector3(0, 0, 0.2);
// with the product banner across the top of the frame: tilt up a little so the shop sits below it
const BANNER_POS = new THREE.Vector3(0, 18.6, 12.6);
const BANNER_LOOK = new THREE.Vector3(0, 0, -1.6);
// LED screen on the back wall: a lower, more frontal view so the wall screen is big and readable
const LED_POS = new THREE.Vector3(0, 11.4, 14.6);
const LED_LOOK = new THREE.Vector3(0, 1.1, -2.0);
/** a frame (TV / board) is drawn over the top of the LIVE screen */
const overlayBanner = (engine: GameEngine) => engine.scene.banner_enabled && engine.scene.banner_style !== "led";
const overviewOf = (engine: GameEngine) =>
  ledOn(engine.scene)
    ? { pos: LED_POS, look: LED_LOOK }
    : overlayBanner(engine)
      ? { pos: BANNER_POS, look: BANNER_LOOK }
      : { pos: OVERVIEW_POS, look: OVERVIEW_LOOK };

/** GAME-07: overview → follow the Chibi → close-up on the box → back, all smoothed. */
function CameraRig({ engine }: { engine: GameEngine }) {
  const { camera } = useThree();
  const look = useRef(overviewOf(engine).look.clone());
  const goalPos = useMemo(() => new THREE.Vector3(), []);
  const goalLook = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    const o = overviewOf(engine);
    camera.position.copy(o.pos);
    look.current.copy(o.look);
    camera.lookAt(o.look);
  }, [camera, engine]);
  useFrame((_, dt) => {
    const a = engine.focused();
    let shot = "overview";
    if (a && !a.removed) {
      if ((a.phase === "show" || a.phase === "hold") && a.held) {
        // close-up: in front of the presented box, slightly above
        const fx = a.pos.x + Math.sin(a.yaw) * 0.34;
        const fz = a.pos.z + Math.cos(a.yaw) * 0.34;
        // slow push-in while the product is presented: frame the Chibi first, then the box
        const t = a.phase === "show" ? Math.min(1, a.fsm.elapsed / 3) : 0;
        const ease = t * t * (3 - 2 * t);
        const dist = 2.0 - 0.85 * ease;
        // with the banner on top, aim a bit higher so the Chibi and the box sit below it
        const lift = overlayBanner(engine) ? 0.42 - 0.12 * ease : 0;
        goalLook.set(fx, 0.5 - 0.1 * ease + lift, fz);
        goalPos.set(fx + Math.sin(a.yaw) * (dist + lift * 0.6), 0.85 - 0.25 * ease + lift * 0.5, fz + Math.cos(a.yaw) * (dist + lift * 0.6));
        shot = "closeup";
      } else {
        const lift = overlayBanner(engine) ? 1.0 : 0;
        goalLook.set(a.pos.x, 0.55 + lift, a.pos.z - lift * 0.8);
        goalPos.set(a.pos.x * 0.7, 4.4 + lift * 0.4, a.pos.z + 6.4 + lift * 0.6);
        shot = "follow";
      }
    } else if (engine.spot && engine.tea.cameraOnTable()) {
      // tea is being served to a gift giver: frame the table
      const T = engine.spot.table;
      const lift = overlayBanner(engine) ? 0.55 : 0;
      goalLook.set(T.x, 0.45 + lift, T.z);
      goalPos.set(T.x, 3.1 + lift * 0.6, T.z + 5.0);
      shot = "tea";
    } else {
      const o = overviewOf(engine);
      goalLook.copy(o.look);
      goalPos.copy(o.pos);
    }
    const k = 1 - Math.exp(-dt * (shot === "closeup" ? 2.6 : 1.8));
    camera.position.lerp(goalPos, k);
    look.current.lerp(goalLook, k);
    camera.lookAt(look.current);
    (window as unknown as { __chibiCamera?: object }).__chibiCamera = {
      shot,
      position: camera.position.toArray().map((v) => +v.toFixed(2)),
      lookAt: look.current.toArray().map((v) => +v.toFixed(2)),
    };
  }, -2); // after engine.step, before avatars and labels
  return null;
}

const tmpV = new THREE.Vector3();
const tmpTop = new THREE.Vector3();
const camUp = new THREE.Vector3();

/** Runs after avatars and camera each frame: lifts or hides overlapping name labels. */
function LabelLayoutSystem({ registry }: { registry: Map<string, LabelEntry> }) {
  const { camera, size } = useThree();
  useFrame(() => {
    const boxes: LabelBox[] = [];
    // sprites face the camera, so their height lies along the camera's own up axis
    camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    for (const [id, e] of registry) {
      const sp = e.sprite;
      sp.position.y = e.baseY;
      if (!sp.visible || !sp.parent?.visible) continue;
      sp.getWorldPosition(tmpV);
      tmpTop.copy(tmpV).addScaledVector(camUp, sp.scale.y);
      const depth = camera.position.distanceTo(tmpV);
      tmpV.project(camera);
      tmpTop.project(camera);
      if (tmpV.z > 1) continue;
      const h = Math.abs(tmpTop.y - tmpV.y) * (size.height / 2);
      boxes.push({ id, x: ((tmpV.x + 1) / 2) * size.width, y: ((1 - tmpV.y) / 2) * size.height + h / 2, w: h * e.aspect, h, depth });
    }
    const placement = layoutLabels(boxes);
    const w = window as unknown as { __chibiDebug?: object; __chibiLabels?: object };
    if (w.__chibiDebug) w.__chibiLabels = { boxes, placement: Object.fromEntries(placement) }; // tests only
    for (const [id, p] of placement) {
      const e = registry.get(id)!;
      e.sprite.visible = p.visible;
      // lift along the screen's vertical (camera up), in world units
      e.sprite.position.y = e.baseY + (p.lift * e.sprite.scale.y * 1.08) / Math.max(0.3, camUp.y);
    }
  });
  return null;
}

/** Shared per-frame numbers for the performance report. */
const perf = { frameMs: [] as number[], simMs: [] as number[], lastFps: null as number | null, gpu: null as string | null };

function FrameLoop({ engine, onFps }: { engine: GameEngine; onFps: (fps: number) => void }) {
  const frames = useRef(0);
  const acc = useRef(0);
  useFrame((_, dt) => {
    const t0 = performance.now();
    engine.step(dt);
    perf.simMs.push(performance.now() - t0);
    perf.frameMs.push(dt * 1000);
    if (perf.frameMs.length > 300) perf.frameMs.shift();
    if (perf.simMs.length > 300) perf.simMs.shift();
    frames.current += 1;
    acc.current += dt;
    if (acc.current >= 1) {
      const fps = frames.current / acc.current;
      perf.lastFps = fps;
      onFps(fps);
      frames.current = 0;
      acc.current = 0;
    }
  }, -3); // game logic first
  return null;
}

const projScreen = new THREE.Matrix4();

/** Level of detail: camera frustum + thresholds for the Chibis (after the camera moved). */
function LodSystem({ engine }: { engine: GameEngine }) {
  const { camera } = useThree();
  const t = useRef(0);
  useFrame((_, dt) => {
    LOD.frame += 1;
    camera.updateMatrixWorld();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    LOD.frustum.setFromProjectionMatrix(projScreen);
    // last frame's tier counts → engine (debug overlay, perf report)
    engine.lod = { ...LOD.counts };
    LOD.counts = { full: 0, reduced: 0, far: 0, hidden: 0 };
    t.current += dt;
    if (t.current >= 1) {
      t.current = 0;
      const p = lodPolicy(engine.avatars.size, perf.lastFps);
      LOD.near = p.near;
      LOD.far = p.far;
      engine.lodLevel = p.level;
    }
  }, -1.5);
  return null;
}

const p95 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Every 5 s: FPS, slow frames, Chibi logic time, draw calls, memory, graphics card (T16). */
function PerfMeter({ engine, quality, onPerf }: { engine: GameEngine; quality: Quality; onPerf?: (r: PerfReport) => void }) {
  const { gl } = useThree();
  const t = useRef(0);
  useEffect(() => {
    try {
      const ctx = gl.getContext();
      const ext = ctx.getExtension("WEBGL_debug_renderer_info");
      perf.gpu = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(ctx.getParameter(ctx.RENDERER));
    } catch {
      perf.gpu = null;
    }
  }, [gl]);
  useFrame((_, dt) => {
    t.current += dt;
    if (t.current < 5 || !onPerf) return;
    t.current = 0;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const frameAvg = avg(perf.frameMs);
    onPerf({
      fps: +(frameAvg > 0 ? 1000 / frameAvg : 0).toFixed(1),
      frame_ms_p95: +p95(perf.frameMs).toFixed(1),
      sim_ms: +avg(perf.simMs).toFixed(2),
      render_calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      heap_mb: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
      gpu: perf.gpu,
      quality,
      avatars: engine.avatars.size,
      lod: { ...engine.lod },
    });
  }, -3);
  return null;
}

function Avatars({ engine }: { engine: GameEngine }) {
  const [, setV] = useState(0);
  const seen = useRef(-1);
  useFrame(() => {
    if (engine.version !== seen.current) {
      seen.current = engine.version;
      setV(engine.version);
    }
  });
  const products = engine.products;
  const focusedId = () => (engine.camera.mode === "follow" ? engine.camera.avatarId : null);
  // tea being served: nobody standing between the camera and the tea table
  const clearView = () => {
    const shot = (window as unknown as { __chibiCamera?: { shot: string; position: number[] } }).__chibiCamera;
    if (!engine.spot || shot?.shot !== "tea") return null;
    const [x, y, z] = shot.position;
    const T = engine.spot.table;
    return { dist: Math.hypot(x - T.x, y - 0.5, z - T.z) - 1.3, keep: engine.tea.guest?.avatarId ?? null };
  };
  return (
    <>
      {[...engine.avatars.values()].map((a) => (
        <ChibiAvatar key={a.info.avatar_id} ctl={a} products={products} focusedId={focusedId} clearView={clearView} />
      ))}
    </>
  );
}

function Scene({ engine }: { engine: GameEngine }) {
  const [layoutVersion, setLayoutVersion] = useState(-1);
  const [sceneVersion, setSceneVersion] = useState(-1);
  const [turn, setTurn] = useState(0);
  useFrame(() => {
    const v = engine.layout ? engine.layout.version * 1000 + (engine.layoutVersion % 1000) : -1;
    if (v !== layoutVersion) setLayoutVersion(v);
    if (engine.sceneVersion !== sceneVersion) setSceneVersion(engine.sceneVersion);
  });
  // wall posters take turns when there are more products than frames
  const seconds = engine.scene.banner_seconds;
  useEffect(() => {
    const id = setInterval(() => setTurn((t) => t + 1), Math.max(3, seconds) * 2000);
    return () => clearInterval(id);
  }, [seconds]);
  const all = engine.layout ? engine.bannerProducts() : [];
  const posters = all.length > 2 ? [0, 1].map((k) => all[(turn * 2 + k) % all.length]) : all;
  return engine.layout ? (
    <>
      <StoreScene key={`${layoutVersion}-${sceneVersion}`} layout={engine.layout} scene={engine.scene} posters={posters} />
      {ledOn(engine.scene) && <LedWall key={`led-${layoutVersion}-${sceneVersion}`} engine={engine} layout={engine.layout} />}
    </>
  ) : null;
}

/** Tea corner with the shop owner (rebuilt when the layout or the shop look changes). */
function Tea({ engine }: { engine: GameEngine }) {
  const [v, setV] = useState(-1);
  useFrame(() => {
    const k = engine.sceneVersion * 100000 + (engine.layout?.version ?? 0) * 100 + (engine.layoutVersion % 100);
    if (k !== v) setV(k);
  });
  return engine.spot ? <TeaCorner key={v} engine={engine} spot={engine.spot} /> : null;
}

/** Lights and sky follow the shop theme. */
function Lights({ engine, q }: { engine: GameEngine; q: (typeof QUALITY)[Quality] }) {
  const [v, setV] = useState(-1);
  const { gl } = useThree();
  useFrame(() => {
    if (engine.sceneVersion !== v) setV(engine.sceneVersion);
  });
  const t = themeOf(engine.scene.theme);
  useEffect(() => {
    gl.domElement.style.background = t.background;
  }, [gl, t]);
  return (
    <>
      <ambientLight intensity={0.45} color={t.ambient} />
      <hemisphereLight args={[t.hemiSky, t.hemiGround, 0.55]} />
      <directionalLight
        position={[6, 13, 7]}
        intensity={1.9}
        color={t.sun}
        castShadow={q.shadows}
        shadow-mapSize={[q.shadowMap, q.shadowMap]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={10}
        shadow-camera-bottom={-10}
      />
      <directionalLight position={[-6, 6, 10]} intensity={0.35} color={t.fill} />
    </>
  );
}

export function World({
  engine,
  quality,
  onFps,
  onPerf,
  debugOverlay = false,
}: {
  engine: GameEngine;
  quality: Quality;
  onFps: (fps: number) => void;
  onPerf?: (r: PerfReport) => void;
  debugOverlay?: boolean;
}) {
  const q = QUALITY[quality];
  const opts = useMemo(() => ({ outlines: q.outlines, shadows: q.shadows }), [q.outlines, q.shadows]);
  const labelRegistry = useMemo(() => new Map<string, LabelEntry>(), []);
  return (
    <Canvas
      key={quality /* shadow-map settings need a fresh renderer */}
      dpr={q.dpr}
      shadows={q.shadows ? "soft" : false}
      flat /* no filmic tone mapping: keeps the cel-shaded colours crisp, not washed out */
      camera={{ fov: 50, near: 0.1, far: 80, position: OVERVIEW_POS.toArray() }}
      gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" }}
      style={{ background: themeOf(engine.scene.theme).background }}
      onCreated={({ gl }) => {
        const el = gl.domElement;
        el.addEventListener("webglcontextlost", () => reportError("webgl", "Mất ngữ cảnh WebGL (card đồ họa/trình duyệt bị quá tải hoặc reset)"));
        el.addEventListener("webglcontextrestored", () => reportError("warning", "Ngữ cảnh WebGL đã khôi phục"));
      }}
    >
      <RenderContext.Provider value={opts}>
        <Lights engine={engine} q={q} />
        <Scene engine={engine} />
        <LabelRegistryContext.Provider value={labelRegistry}>
          <Avatars engine={engine} />
          <Tea engine={engine} />
          {debugOverlay && <DebugProjector engine={engine} />}
          <LabelLayoutSystem registry={labelRegistry} />
        </LabelRegistryContext.Provider>
        <CameraRig engine={engine} />
        <LodSystem engine={engine} />
        <FrameLoop engine={engine} onFps={onFps} />
        <PerfMeter engine={engine} quality={quality} onPerf={onPerf} />
      </RenderContext.Provider>
    </Canvas>
  );
}
