// 3D preview of a product box in the dashboard, lit like the game. Loaded lazily so the
// dashboard does not pull three.js until the owner opens the PDF face picker.

import { Canvas, useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";
import { ProductVisual } from "../game/ProductBox";
import type { ProductInfo } from "../types/protocol";

function Spinner({ product, drag }: { product: ProductInfo; drag: { current: number | null } }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!g.current) return;
    if (drag.current === null) g.current.rotation.y += dt * 0.6;
    else {
      g.current.rotation.y = drag.current;
    }
  });
  return (
    <group ref={g} rotation={[0, -0.6, 0]}>
      <ProductVisual product={product} />
    </group>
  );
}

export default function BoxPreview3D({ product }: { product: ProductInfo }) {
  const s = product.box_size;
  const r = Math.max(s.w, s.h, s.d);
  const drag = useRef<number | null>(null);
  const start = useRef<{ x: number; rot: number } | null>(null);
  const [hint, setHint] = useState(true);
  return (
    <div
      className="box-preview"
      data-testid="box-preview-3d"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const cur = drag.current ?? 0;
        start.current = { x: e.clientX, rot: cur };
        drag.current = cur;
        setHint(false);
      }}
      onPointerMove={(e) => {
        if (start.current) drag.current = start.current.rot + (e.clientX - start.current.x) * 0.012;
      }}
      onPointerUp={() => {
        start.current = null;
      }}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [r * 0.9, r * 0.95, r * 2.0], fov: 35, near: 0.01, far: 50 }}
        onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#fbf6f0"]} />
        <hemisphereLight args={["#ffffff", "#d9c8b4", 1.6]} />
        <directionalLight position={[2, 3, 2.5]} intensity={1.8} />
        <directionalLight position={[-2, 1, -1]} intensity={0.5} />
        <Spinner product={product} drag={drag} />
      </Canvas>
      {hint && <span className="box-preview-hint">Kéo để xoay</span>}
    </div>
  );
}
