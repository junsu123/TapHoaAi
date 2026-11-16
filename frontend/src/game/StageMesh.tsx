// The dance stage in front of the shop: a low wooden platform with steps, a curtain with the
// "SÂN KHẤU" sign and two spotlights that light up while someone dances.

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { GameEngine } from "./GameEngine";
import { toon } from "./palette";
import type { StageSpot } from "./stage";
import { OutlinedBox } from "./StoreScene";

function signTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3a1630";
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = "#f2c14e";
  g.lineWidth = 8;
  g.strokeRect(8, 8, 496, 112);
  g.fillStyle = "#ffe3a3";
  g.font = '900 64px "Be Vietnam Pro", "DejaVu Sans", sans-serif';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("♪ SÂN KHẤU ♪", 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function StageMesh({ engine, spot }: { engine: GameEngine; spot: StageSpot }) {
  const { center, w, d, height: h, side } = spot;
  const sign = useMemo(signTexture, []);
  const beams = useRef<THREE.Group>(null!);
  const glow = useRef<THREE.Mesh>(null!);
  const beamMat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#ffd2ea", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#fff1a8", transparent: true, opacity: 0, depthWrite: false }), []);
  const inner = center.x - side * (w / 2);
  useFrame((state) => {
    const dancing = engine.stage?.current?.phase === "dancing";
    const t = state.clock.elapsedTime;
    const target = dancing ? 0.16 + Math.sin(t * 6) * 0.05 : 0;
    beamMat.opacity += (target - beamMat.opacity) * 0.15;
    beamMat.color.setHSL((t * 0.08) % 1, 0.8, 0.8);
    glowMat.opacity += ((dancing ? 0.45 : 0) - glowMat.opacity) * 0.15;
    beams.current.visible = beamMat.opacity > 0.01;
    glow.current.visible = glowMat.opacity > 0.01;
  });
  const lampX = [center.x - w / 2 + 0.12, center.x + w / 2 - 0.12];
  const back = center.z - d / 2;
  return (
    <group>
      {/* platform, top boards and gold front edge */}
      <OutlinedBox args={[w, h, d]} position={[center.x, h / 2, center.z]} color="#6b3f2a" />
      <mesh material={toon("#8a5636")} position={[center.x, h + 0.004, center.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w - 0.08, d - 0.08]} />
      </mesh>
      <OutlinedBox args={[w, 0.05, 0.05]} position={[center.x, h - 0.02, center.z + d / 2]} color="#e2b44a" />
      {/* two steps on the side that faces the shop's middle */}
      <OutlinedBox args={[0.34, h * 0.5, 0.8]} position={[inner - side * 0.17, h * 0.25, center.z + 0.1]} color="#7a4a30" />
      {/* curtain and sign at the back */}
      <OutlinedBox args={[w, 1.05, 0.06]} position={[center.x, h + 0.52, back + 0.03]} color="#7b2350" />
      {[-0.36, 0, 0.36].map((k) => (
        <mesh key={k} material={toon("#94306a")} position={[center.x + k * w, h + 0.5, back + 0.07]}>
          <boxGeometry args={[0.05, 1.0, 0.02]} />
        </mesh>
      ))}
      <mesh position={[center.x, h + 1.2, back + 0.08]}>
        <planeGeometry args={[w * 0.82, (w * 0.82) / 4]} />
        <meshBasicMaterial map={sign} toneMapped={false} />
      </mesh>
      {/* spotlight poles */}
      {lampX.map((x) => (
        <group key={x} position={[x, 0, back + 0.12]}>
          <mesh material={toon("#2d2a2a")} position={[0, (h + 1.6) / 2, 0]}>
            <cylinderGeometry args={[0.025, 0.03, h + 1.6, 8]} />
          </mesh>
          <mesh material={toon("#1e1c1c")} position={[0, h + 1.62, 0.06]} rotation={[0.9, 0, 0]}>
            <cylinderGeometry args={[0.07, 0.1, 0.16, 12]} />
          </mesh>
        </group>
      ))}
      {/* light beams + glow on the floor, only while someone dances */}
      <group ref={beams}>
        {lampX.map((x) => {
          const from = new THREE.Vector3(x, h + 1.6, back + 0.2);
          const to = new THREE.Vector3(spot.top.x, h, spot.top.z);
          const len = from.distanceTo(to);
          const mid = from.clone().add(to).multiplyScalar(0.5);
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from).normalize());
          return (
            <mesh key={x} material={beamMat} position={mid.toArray()} quaternion={q}>
              <coneGeometry args={[0.45, len, 20, 1, true]} />
            </mesh>
          );
        })}
      </group>
      <mesh ref={glow} material={glowMat} position={[spot.top.x, h + 0.01, spot.top.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.6, 28]} />
      </mesh>
    </group>
  );
}
