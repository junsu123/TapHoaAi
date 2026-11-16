// The dance stage: a round stage in the middle of the shop (default) or a square one at the front,
// and the light show that runs while a Chibi dances on it — the shop lights go down (World →
// Lights), coloured moving beams sweep over the dancer, the floor and the rim light up in time
// with the beat, sparkles rise, and a burst of confetti marks the start of every turn.

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { GameEngine } from "./GameEngine";
import { toon } from "./palette";
import type { StageSpot } from "./stage";
import { OutlinedBox } from "./StoreScene";

const BPS = 118 / 60; // the beat the lights follow
const WOOD = "#6b3f2a";
const WOOD_TOP = "#8a5636";
const GOLD = "#e2b44a";

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
  t.anisotropy = 4;
  return t;
}

/** Soft round dot for sparkles and confetti. */
function dotTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.35, "rgba(255,255,255,.85)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const IDLE_LAMP = new THREE.Color("#c99a45");

const glowMat = (color: string) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });

export function StageMesh({ engine, spot }: { engine: GameEngine; spot: StageSpot }) {
  const sign = useMemo(signTexture, []);
  // where the moving heads hang (the beams start there)
  const heads = useMemo<THREE.Vector3[]>(() => {
    const { center: c, height: h } = spot;
    if (spot.shape === "round") {
      const back = c.z - spot.radius * 0.72;
      const span = spot.radius * 0.95;
      return [
        new THREE.Vector3(c.x - span, h + 2.25, back),
        new THREE.Vector3(c.x + span, h + 2.25, back),
        new THREE.Vector3(c.x - span * 2.1, h + 2.6, c.z + 0.6),
        new THREE.Vector3(c.x + span * 2.1, h + 2.6, c.z + 0.6),
      ];
    }
    const back = c.z - spot.d / 2;
    return [new THREE.Vector3(c.x - spot.w / 2 + 0.12, h + 1.62, back + 0.2), new THREE.Vector3(c.x + spot.w / 2 - 0.12, h + 1.62, back + 0.2)];
  }, [spot]);
  return (
    <group>
      {spot.shape === "round" ? <RoundStage spot={spot} sign={sign} heads={heads} /> : <BoxStage spot={spot} sign={sign} heads={heads} />}
      <LightShow engine={engine} spot={spot} heads={heads} />
    </group>
  );
}

/** Round stage in the middle aisle: dark wood drum, gold rim, steps, a light truss with the sign. */
function RoundStage({ spot, sign, heads }: { spot: StageSpot; sign: THREE.Texture; heads: THREE.Vector3[] }) {
  const { center: c, radius: r, height: h } = spot;
  const dir = new THREE.Vector2(spot.approach.x - c.x, spot.approach.z - c.z).normalize();
  const stepYaw = Math.atan2(dir.x, dir.y);
  const back = c.z - r * 0.72;
  const post = r * 0.95;
  return (
    <group>
      <mesh material={toon(WOOD)} position={[c.x, h / 2, c.z]} castShadow receiveShadow>
        <cylinderGeometry args={[r, r + 0.04, h, 40]} />
      </mesh>
      <mesh material={toon(WOOD_TOP)} position={[c.x, h + 0.003, c.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[r - 0.03, 40]} />
      </mesh>
      <mesh material={toon(GOLD)} position={[c.x, h - 0.01, c.z]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[r - 0.01, 0.025, 6, 48]} />
      </mesh>
      {/* two steps up, on the side facing the walkway */}
      <group position={[spot.approach.x - dir.x * 0.3, 0, spot.approach.z - dir.y * 0.3]} rotation={[0, stepYaw, 0]}>
        <OutlinedBox args={[0.7, h * 0.5, 0.26]} position={[0, h * 0.25, 0.1]} color="#7a4a30" />
        <OutlinedBox args={[0.7, h * 0.5, 0.2]} position={[0, h * 0.5 + 0.0, -0.12]} color="#7a4a30" />
      </group>
      {/* light truss: two posts, a cross bar, the sign and the moving heads */}
      {[-post, post].map((dx) => (
        <mesh key={dx} material={toon("#2d2a2a")} position={[c.x + dx, (h + 2.3) / 2, back]}>
          <cylinderGeometry args={[0.03, 0.035, h + 2.3, 8]} />
        </mesh>
      ))}
      <mesh material={toon("#2d2a2a")} position={[c.x, h + 2.3, back]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.035, 0.035, post * 2 + 0.1, 8]} />
      </mesh>
      <mesh position={[c.x, h + 2.02, back + 0.02]}>
        <planeGeometry args={[post * 1.5, (post * 1.5) / 4]} />
        <meshBasicMaterial map={sign} toneMapped={false} />
      </mesh>
      {heads.slice(0, 2).map((p, i) => (
        <mesh key={i} material={toon("#1e1c1c")} position={[p.x, p.y - 0.06, p.z]}>
          <cylinderGeometry args={[0.07, 0.1, 0.16, 12]} />
        </mesh>
      ))}
      {/* side towers for the two side beams */}
      {heads.slice(2).map((p, i) => (
        <group key={i}>
          <mesh material={toon("#2d2a2a")} position={[p.x, p.y / 2, p.z]}>
            <cylinderGeometry args={[0.025, 0.03, p.y, 8]} />
          </mesh>
          <mesh material={toon("#1e1c1c")} position={[p.x, p.y + 0.02, p.z]}>
            <sphereGeometry args={[0.08, 12, 8]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Square stage at the front corner, with curtain, sign and two lamps (the earlier look). */
function BoxStage({ spot, sign, heads }: { spot: StageSpot; sign: THREE.Texture; heads: THREE.Vector3[] }) {
  const { center, w, d, height: h, side } = spot;
  const inner = center.x - side * (w / 2);
  const back = center.z - d / 2;
  return (
    <group>
      <OutlinedBox args={[w, h, d]} position={[center.x, h / 2, center.z]} color={WOOD} />
      <mesh material={toon(WOOD_TOP)} position={[center.x, h + 0.004, center.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w - 0.08, d - 0.08]} />
      </mesh>
      <OutlinedBox args={[w, 0.05, 0.05]} position={[center.x, h - 0.02, center.z + d / 2]} color={GOLD} />
      <OutlinedBox args={[0.34, h * 0.5, 0.8]} position={[inner - side * 0.17, h * 0.25, center.z + 0.1]} color="#7a4a30" />
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
      {heads.map((p) => (
        <group key={p.x} position={[p.x, 0, p.z - 0.08]}>
          <mesh material={toon("#2d2a2a")} position={[0, p.y / 2, 0]}>
            <cylinderGeometry args={[0.025, 0.03, p.y, 8]} />
          </mesh>
          <mesh material={toon("#1e1c1c")} position={[0, p.y, 0.06]} rotation={[0.9, 0, 0]}>
            <cylinderGeometry args={[0.07, 0.1, 0.16, 12]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

const SPARKS = 70;
const CONFETTI = 110;

/** Everything that lights up while someone dances (hidden otherwise: no cost when idle). */
function LightShow({ engine, spot, heads }: { engine: GameEngine; spot: StageSpot; heads: THREE.Vector3[] }) {
  const h = spot.height;
  const top = useMemo(() => new THREE.Vector3(spot.top.x, h, spot.top.z), [spot, h]);
  const R = spot.shape === "round" ? spot.radius : Math.min(spot.w, spot.d) / 2;
  const root = useRef<THREE.Group>(null!);
  const light = useRef<THREE.PointLight>(null!);
  const level = useRef(0); // 0 = off … 1 = full show
  const wasOn = useRef(false);
  const confettiT = useRef(99);

  // ---- materials (one each, coloured per frame)
  const beamMats = useMemo(() => heads.map(() => glowMat("#ffffff")), [heads]);
  const glow = useMemo(() => glowMat("#fff1a8"), []);
  const rings = useMemo(() => [glowMat("#ffffff"), glowMat("#ffffff")], []);
  // the floor: 8 wedges (round) or 4 × 2 tiles (square) that change colour on the beat
  const floor = useMemo(() => {
    const n = 8;
    return Array.from({ length: n }, () => glowMat("#ffffff"));
  }, []);
  // the rim: little lamps chasing round the edge
  const LAMPS = spot.shape === "round" ? 24 : 16;
  const lamps = useMemo(() => Array.from({ length: LAMPS }, () => new THREE.MeshBasicMaterial({ color: "#ffcf6b", toneMapped: false })), [LAMPS]);
  const lampPos = useMemo(() => {
    if (spot.shape === "round")
      return Array.from({ length: LAMPS }, (_, i) => {
        const a = (i / LAMPS) * Math.PI * 2;
        return [spot.center.x + Math.sin(a) * (R + 0.02), h - 0.05, spot.center.z + Math.cos(a) * (R + 0.02)] as const;
      });
    // square: along the front edge and the two sides
    return Array.from({ length: LAMPS }, (_, i) => [spot.center.x - spot.w / 2 + ((i + 0.5) / LAMPS) * spot.w, h - 0.05, spot.center.z + spot.d / 2 + 0.03] as const);
  }, [spot, LAMPS, R, h]);

  // ---- beams: open cones, re-aimed every frame at a point circling the dancer
  const beamGeo = useMemo(() => {
    const g = new THREE.ConeGeometry(0.42, 1, 24, 1, true);
    g.translate(0, -0.5, 0); // tip at the origin, opening downwards along -y
    return g;
  }, []);
  const beamRefs = useRef<(THREE.Mesh | null)[]>([]);

  // ---- sparkles and confetti
  const dot = useMemo(dotTexture, []);
  const sparks = useMemo(() => {
    const pos = new Float32Array(SPARKS * 3);
    const col = new Float32Array(SPARKS * 3);
    const seed = new Float32Array(SPARKS * 3); // angle, radius, speed
    const c = new THREE.Color();
    for (let i = 0; i < SPARKS; i++) {
      seed[i * 3] = Math.random() * Math.PI * 2;
      seed[i * 3 + 1] = 0.25 + Math.random() * (R + 0.2);
      seed[i * 3 + 2] = 0.35 + Math.random() * 0.6;
      c.setHSL(0.1 + Math.random() * 0.12, 1, 0.75);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 0.09, map: dot, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    return { g, m, seed, pos };
  }, [dot, R]);
  const confetti = useMemo(() => {
    const pos = new Float32Array(CONFETTI * 3);
    const vel = new Float32Array(CONFETTI * 3);
    const col = new Float32Array(CONFETTI * 3);
    const c = new THREE.Color();
    for (let i = 0; i < CONFETTI; i++) {
      c.setHSL(Math.random(), 0.9, 0.6);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 0.075, map: dot, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    return { g, m, pos, vel };
  }, [dot]);
  const burst = () => {
    const { pos, vel } = confetti;
    for (let i = 0; i < CONFETTI; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.6 + Math.random() * 1.6;
      pos.set([top.x + (Math.random() - 0.5) * 0.2, h + 1.6 + Math.random() * 0.4, top.z + (Math.random() - 0.5) * 0.2], i * 3);
      vel.set([Math.cos(a) * s, 1.2 + Math.random() * 1.8, Math.sin(a) * s], i * 3);
    }
    confetti.g.attributes.position.needsUpdate = true;
    confettiT.current = 0;
  };

  const tmp = useMemo(() => ({ dir: new THREE.Vector3(), aim: new THREE.Vector3(), up: new THREE.Vector3(0, -1, 0), q: new THREE.Quaternion(), c: new THREE.Color() }), []);

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const on = engine.stageShot();
    if (on && !wasOn.current) burst();
    wasOn.current = on;
    level.current += ((on ? 1 : 0) - level.current) * Math.min(1, dt * 3);
    const L = level.current;
    const t = state.clock.elapsedTime;
    const beat = (t * BPS) % 1;
    const pulse = Math.exp(-beat * 5); // 1 on the beat, fading
    const bar = Math.floor(t * BPS) % 8;

    // rim lamps glow softly even when idle (the stage is always a little inviting)
    for (let i = 0; i < lamps.length; i++) {
      if (L < 0.02) {
        lamps[i].color.copy(IDLE_LAMP);
        continue;
      }
      const chase = (i / lamps.length + t * 0.6) % 1;
      tmp.c.setHSL((chase + t * 0.05) % 1, 1, 0.45 + 0.25 * (i % 2 === bar % 2 ? pulse : 0.3));
      lamps[i].color.copy(tmp.c).lerp(IDLE_LAMP, 1 - L);
    }
    const visible = L > 0.02;
    root.current.visible = visible;
    confettiT.current += dt;
    if (!visible) return;

    // moving beams: each sweeps its own circle around the dancer, colours walk round the wheel
    heads.forEach((from, i) => {
      const m = beamRefs.current[i];
      if (!m) return;
      const a = t * (0.9 + i * 0.23) + i * 1.7;
      const rr = 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.7 + i));
      tmp.aim.set(top.x + Math.cos(a) * rr, h, top.z + Math.sin(a) * rr);
      tmp.dir.subVectors(tmp.aim, from);
      const len = tmp.dir.length();
      tmp.q.setFromUnitVectors(tmp.up, tmp.dir.normalize());
      m.position.copy(from);
      m.quaternion.copy(tmp.q);
      m.scale.set(1, len, 1);
      beamMats[i].color.setHSL((t * 0.12 + i * 0.25) % 1, 1, 0.6);
      beamMats[i].opacity = L * (0.13 + 0.12 * (i % 2 === bar % 2 ? pulse : 0.4));
    });

    // the floor under the dancer
    glow.opacity = L * (0.35 + 0.3 * pulse);
    glow.color.setHSL((t * 0.1) % 1, 0.9, 0.7);
    floor.forEach((m, i) => {
      const lit = (i + bar) % 2 === 0;
      m.color.setHSL((i / floor.length + t * 0.15) % 1, 1, 0.55);
      m.opacity = L * (lit ? 0.25 + 0.35 * pulse : 0.08);
    });
    // two rings rippling out on every beat
    rings.forEach((m, i) => {
      const ph = (beat + i * 0.5) % 1;
      m.opacity = L * 0.55 * (1 - ph);
      m.color.setHSL((t * 0.2 + i * 0.5) % 1, 1, 0.65);
      const mesh = (root.current.getObjectByName(`ring${i}`) as THREE.Mesh | undefined) ?? null;
      if (mesh) mesh.scale.setScalar(0.4 + ph * (R + 0.9));
    });

    // a coloured light above the stage (lights the dancer and the shelves around)
    light.current.intensity = L * (2.2 + 2.5 * pulse);
    light.current.color.setHSL((t * 0.1) % 1, 0.8, 0.6);

    // sparkles rising round the dancer
    const sp = sparks;
    for (let i = 0; i < SPARKS; i++) {
      const y = (t * sp.seed[i * 3 + 2] + i * 0.137) % 1;
      const ang = sp.seed[i * 3] + t * 0.4;
      const rr = sp.seed[i * 3 + 1];
      sp.pos.set([top.x + Math.cos(ang) * rr, h + 0.1 + y * 2.2, top.z + Math.sin(ang) * rr], i * 3);
    }
    sp.g.attributes.position.needsUpdate = true;
    sp.m.opacity = L * (0.55 + 0.35 * pulse);

    // confetti: falls for ~4 s after the dancer steps up
    const cf = confetti;
    if (confettiT.current < 4.5) {
      for (let i = 0; i < CONFETTI; i++) {
        cf.vel[i * 3 + 1] -= 3.2 * dt;
        cf.vel[i * 3] *= 1 - 0.9 * dt;
        cf.vel[i * 3 + 2] *= 1 - 0.9 * dt;
        let y = cf.pos[i * 3 + 1] + Math.max(cf.vel[i * 3 + 1], -1.1) * dt;
        if (y < 0.02) y = 0.02;
        cf.pos[i * 3] += cf.vel[i * 3] * dt + Math.sin(t * 6 + i) * 0.004;
        cf.pos[i * 3 + 1] = y;
        cf.pos[i * 3 + 2] += cf.vel[i * 3 + 2] * dt;
      }
      cf.g.attributes.position.needsUpdate = true;
      cf.m.opacity = Math.min(1, (4.5 - confettiT.current) / 1.2);
    } else cf.m.opacity = 0;
  });

  const round = spot.shape === "round";
  return (
    <group>
      {/* rim lamps: always there */}
      {lampPos.map((p, i) => (
        <mesh key={i} material={lamps[i]} position={p as unknown as [number, number, number]}>
          <sphereGeometry args={[0.035, 8, 6]} />
        </mesh>
      ))}
      <group ref={root} visible={false}>
        <pointLight ref={light} position={[top.x, h + 1.9, top.z + 0.3]} distance={6} decay={1.4} intensity={0} />
        {heads.map((_, i) => (
          <mesh key={i} ref={(m) => {
              beamRefs.current[i] = m;
            }} geometry={beamGeo} material={beamMats[i]} renderOrder={3} />
        ))}
        {/* disco floor: wedges on the round stage, tiles on the square one */}
        {round
          ? floor.map((m, i) => (
              <mesh key={i} material={m} position={[spot.center.x, h + 0.008, spot.center.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
                <circleGeometry args={[R - 0.06, 6, (i / floor.length) * Math.PI * 2, (Math.PI * 2) / floor.length - 0.04]} />
              </mesh>
            ))
          : floor.map((m, i) => {
              const cols = 4;
              const cw = (spot.w - 0.12) / cols;
              const ch = (spot.d - 0.12) / 2;
              const cx = spot.center.x - (spot.w - 0.12) / 2 + cw * ((i % cols) + 0.5);
              const cz = spot.center.z - (spot.d - 0.12) / 2 + ch * (Math.floor(i / cols) + 0.5);
              return (
                <mesh key={i} material={m} position={[cx, h + 0.008, cz]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
                  <planeGeometry args={[cw - 0.04, ch - 0.04]} />
                </mesh>
              );
            })}
        <mesh material={glow} position={[top.x, h + 0.012, top.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
          <circleGeometry args={[0.45, 28]} />
        </mesh>
        {rings.map((m, i) => (
          <mesh key={i} name={`ring${i}`} material={m} position={[top.x, i === 0 ? h + 0.015 : 0.02, top.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
            <ringGeometry args={[0.92, 1, 40]} />
          </mesh>
        ))}
        <points geometry={sparks.g} material={sparks.m} renderOrder={4} frustumCulled={false} />
      </group>
      <points geometry={confetti.g} material={confetti.m} renderOrder={4} frustumCulled={false} />
    </group>
  );
}
