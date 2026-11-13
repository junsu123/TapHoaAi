import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ChibiAvatar } from "./ChibiAvatar";
import type { GameEngine } from "./GameEngine";
import { RenderContext } from "./palette";
import { StoreScene } from "./StoreScene";

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

/** GAME-07: overview → follow the Chibi → close-up on the box → back, all smoothed. */
function CameraRig({ engine }: { engine: GameEngine }) {
  const { camera } = useThree();
  const look = useRef(OVERVIEW_LOOK.clone());
  const goalPos = useMemo(() => new THREE.Vector3(), []);
  const goalLook = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    camera.position.copy(OVERVIEW_POS);
    camera.lookAt(OVERVIEW_LOOK);
  }, [camera]);
  useFrame((_, dt) => {
    const a = engine.focused();
    let shot = "overview";
    if (a && !a.removed) {
      if ((a.phase === "show" || a.phase === "hold") && a.held) {
        // close-up: in front of the presented box, slightly above
        const fx = a.pos.x + Math.sin(a.yaw) * 0.34;
        const fz = a.pos.z + Math.cos(a.yaw) * 0.34;
        goalLook.set(fx, 0.5, fz);
        goalPos.set(fx + Math.sin(a.yaw) * 2.0, 0.85, fz + Math.cos(a.yaw) * 2.0);
        shot = "closeup";
      } else {
        goalLook.set(a.pos.x, 0.55, a.pos.z);
        goalPos.set(a.pos.x * 0.7, 4.4, a.pos.z + 6.4);
        shot = "follow";
      }
    } else {
      goalLook.copy(OVERVIEW_LOOK);
      goalPos.copy(OVERVIEW_POS);
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
  });
  return null;
}

function FrameLoop({ engine, onFps }: { engine: GameEngine; onFps: (fps: number) => void }) {
  const frames = useRef(0);
  const acc = useRef(0);
  useFrame((_, dt) => {
    engine.step(dt);
    frames.current += 1;
    acc.current += dt;
    if (acc.current >= 1) {
      onFps(frames.current / acc.current);
      frames.current = 0;
      acc.current = 0;
    }
  });
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
  return (
    <>
      {[...engine.avatars.values()].map((a) => (
        <ChibiAvatar key={a.info.avatar_id} ctl={a} products={products} focusedId={focusedId} />
      ))}
    </>
  );
}

function Scene({ engine }: { engine: GameEngine }) {
  const [layoutVersion, setLayoutVersion] = useState(-1);
  useFrame(() => {
    const v = engine.layout ? engine.layout.version * 1000 + (engine.layoutVersion % 1000) : -1;
    if (v !== layoutVersion) setLayoutVersion(v);
  });
  return engine.layout ? <StoreScene key={layoutVersion} layout={engine.layout} /> : null;
}

export function World({ engine, quality, onFps }: { engine: GameEngine; quality: Quality; onFps: (fps: number) => void }) {
  const q = QUALITY[quality];
  const opts = useMemo(() => ({ outlines: q.outlines, shadows: q.shadows }), [q.outlines, q.shadows]);
  return (
    <Canvas
      key={quality /* shadow-map settings need a fresh renderer */}
      dpr={q.dpr}
      shadows={q.shadows ? "soft" : false}
      flat /* no filmic tone mapping: keeps the cel-shaded colours crisp, not washed out */
      camera={{ fov: 50, near: 0.1, far: 80, position: OVERVIEW_POS.toArray() }}
      gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" }}
      style={{ background: "linear-gradient(#ffd9e6, #fff1e0)" }}
    >
      <RenderContext.Provider value={opts}>
        <ambientLight intensity={0.45} color="#fff4f8" />
        <hemisphereLight args={["#fff2f7", "#e7b48c", 0.55]} />
        <directionalLight
          position={[6, 13, 7]}
          intensity={1.9}
          color="#fff6ea"
          castShadow={q.shadows}
          shadow-mapSize={[q.shadowMap, q.shadowMap]}
          shadow-bias={-0.0004}
          shadow-normalBias={0.02}
          shadow-camera-left={-9}
          shadow-camera-right={9}
          shadow-camera-top={10}
          shadow-camera-bottom={-10}
        />
        <directionalLight position={[-6, 6, 10]} intensity={0.35} color="#ffd9ec" />
        <Scene engine={engine} />
        <Avatars engine={engine} />
        <CameraRig engine={engine} />
        <FrameLoop engine={engine} onFps={onFps} />
      </RenderContext.Provider>
    </Canvas>
  );
}
