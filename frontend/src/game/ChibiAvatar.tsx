// Procedural Chibi (M1): big head, small body, right-hand socket. Reads its controller every
// frame through refs, so React does not re-render per frame. M2 swaps in GLB models with a
// shared skeleton, keeping the `rightHandSocket` contract.

import { useFrame, useThree } from "@react-three/fiber";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ProductInfo } from "../types/protocol";
import type { AvatarController } from "./AvatarController";
import { appearanceFromSeed, GEO, GEO_LOW, LabelRegistryContext, OUTLINE_MAT, RenderContext, toon, WHITE } from "./palette";
import { LOD, lodTier, type LodTier } from "./lod";
import { ProductVisual } from "./ProductBox";
import { nameTexture } from "./nameTexture";

const tmp = new THREE.Vector3();
const tmpHand = new THREE.Vector3();
const ease = (t: number) => t * t * (3 - 2 * t);
const LABEL_Y = 1.42;
const sphere = new THREE.Sphere(new THREE.Vector3(), 0.95);

export function ChibiAvatar({
  ctl,
  products,
  focusedId,
  clearView,
}: {
  ctl: AvatarController;
  products: Map<string, ProductInfo>;
  focusedId: () => string | null;
  /** a shot that must not be blocked: Chibis closer to the lens than `dist` are hidden */
  clearView?: () => { dist: number; keep: string | null } | null;
}) {
  const root = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const armL = useRef<THREE.Group>(null!);
  const armR = useRef<THREE.Group>(null!);
  const legL = useRef<THREE.Group>(null!);
  const legR = useRef<THREE.Group>(null!);
  const hand = useRef<THREE.Object3D>(null!); // rightHandSocket
  const label = useRef<THREE.Sprite>(null!);
  const emote = useRef<THREE.Sprite>(null!);
  const emoteIcon = useRef<string | null>(null);
  const emoteMat = useMemo(() => new THREE.SpriteMaterial({ depthTest: false, transparent: true }), []);
  useEffect(() => () => emoteMat.dispose(), [emoteMat]);
  const cup = useRef<THREE.Group>(null!);
  const heldBox = useRef<THREE.Group>(null!);
  const { camera } = useThree();
  const labels = useContext(LabelRegistryContext);
  const outlineMeshes = useRef<THREE.Object3D[]>([]);
  const detailMeshes = useRef<THREE.Object3D[]>([]);
  const lodMeshes = useRef<{ mesh: THREE.Mesh; hi: THREE.BufferGeometry; lo: THREE.BufferGeometry }[]>([]);
  const tierRef = useRef<LodTier | null>(null);
  const { outlines: outlinesAllowed } = useContext(RenderContext);

  const look = useMemo(() => appearanceFromSeed(ctl.info.appearance_seed), [ctl.info.appearance_seed]);
  const { texture, aspect } = useMemo(() => nameTexture(ctl.info.nickname, ctl.info.is_demo), [ctl.info.nickname, ctl.info.is_demo]);
  // re-render only when the carried product changes (not every frame)
  const [heldId, setHeldId] = useState<string | null>(ctl.held?.productId ?? null);
  const heldProduct = heldId ? products.get(heldId) : undefined;
  const labelMat = useMemo(() => new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }), [texture]);
  useEffect(() => () => labelMat.dispose(), [labelMat]);
  useEffect(() => {
    const id = ctl.info.avatar_id;
    labels?.set(id, { sprite: label.current, baseY: LABEL_Y, aspect });
    return () => {
      labels?.delete(id);
    };
  }, [labels, aspect, ctl.info.avatar_id]);
  // collect outline / face-detail / swappable meshes once (and whenever the look changes) for LOD
  useEffect(() => {
    const outl: THREE.Object3D[] = [];
    const det: THREE.Object3D[] = [];
    const swap: { mesh: THREE.Mesh; hi: THREE.BufferGeometry; lo: THREE.BufferGeometry }[] = [];
    root.current.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material === OUTLINE_MAT) outl.push(o);
      if (o.userData.detail) det.push(o);
      const lo = m.isMesh ? GEO_LOW.get(m.geometry) : undefined;
      if (lo) swap.push({ mesh: m, hi: m.geometry, lo });
    });
    outlineMeshes.current = outl;
    detailMeshes.current = det;
    lodMeshes.current = swap;
    tierRef.current = null; // re-apply
  }, [look, outlinesAllowed]);

  /** Show / hide the parts for a render tier (only when the tier changes). */
  const applyTier = (tier: LodTier) => {
    if (tierRef.current === tier) return;
    tierRef.current = tier;
    for (const o of outlineMeshes.current) o.visible = tier === "full";
    for (const o of detailMeshes.current) o.visible = tier === "full" || tier === "reduced";
    for (const x of lodMeshes.current) x.mesh.geometry = tier === "far" ? x.lo : x.hi;
  };

  useFrame((state) => {
    const t = state.clock.elapsedTime + (ctl.info.appearance_seed % 100) * 0.1;
    // the pose drawn: the state's own clip, or the nearest one this rig has (T12)
    const st = ctl.pose;
    root.current.position.set(ctl.pos.x, 0, ctl.pos.z);
    root.current.rotation.y = ctl.yaw;

    // ---- level of detail (T16): never reduce the focused Chibi or one carrying a box
    const focused = focusedId() === ctl.info.avatar_id;
    const dist = camera.position.distanceTo(root.current.position);
    sphere.center.set(ctl.pos.x, 0.6, ctl.pos.z);
    const tier = lodTier(dist, LOD.frustum.intersectsSphere(sphere), focused || !!ctl.held);
    LOD.counts[tier] += 1;
    if (tier === "hidden") {
      // outside the picture: keep the position for when it walks back in, skip the pose
      root.current.visible = false;
      if ((ctl.held?.productId ?? null) !== heldId) setHeldId(ctl.held?.productId ?? null);
      heldBox.current.visible = false;
      return;
    }
    applyTier(tier);
    // far away: the pose is sampled every other frame (Chibis take turns)
    const samplePose = tier !== "far" || (LOD.frame + ctl.info.appearance_seed) % 2 === 0;

    // ---- procedural animation per FSM state
    let bob = Math.sin(t * 2.2) * 0.01;
    if (samplePose) {
    let lArm = 0.15;
    let rArm = 0.15;
    let rArmSide = -0.12;
    let lArmSide = 0.12;
    let legSwing = 0;
    let headTilt = 0;
    let headYaw = 0;
    let headPitch = 0;
    let bodyRoll = 0;
    let spin = 0;
    let lean = 0;
    const e = ctl.fsm.elapsed;
    if (st === "walk" || (ctl.phase === "leave" && st !== "idle")) {
      const w = Math.sin(t * 11);
      legSwing = w * 0.6;
      lArm = -w * 0.5;
      rArm = w * 0.5;
      bob = Math.abs(Math.cos(t * 11)) * 0.035;
    } else if (st === "wave") {
      rArm = -2.6;
      rArmSide = -0.5 + Math.sin(t * 10) * 0.35;
    } else if (st === "inspect") {
      lean = 0.18;
      headTilt = 0.2;
      rArm = -0.6;
    } else if (st === "pickup") {
      lean = 0.15;
      rArm = -1.35;
      lArm = -0.4;
    } else if (st === "hold") {
      rArm = -1.2;
      lArm = -0.9;
      bob = Math.max(0, Math.sin(Math.min(1, e / 0.4) * Math.PI)) * 0.08; // FUN_SURPRISE: hop, found it!
    } else if (st === "show") {
      rArm = -1.45 + Math.sin(t * 3) * 0.05;
      lArm = -1.25 + Math.sin(t * 3) * 0.05;
      rArmSide = -0.45;
      lArmSide = 0.45;
      bob = Math.abs(Math.sin(t * 3)) * 0.03;
    } else if (st === "return") {
      lean = 0.12;
      rArm = -1.3;
    } else if (st === "dance") {
      bob = Math.abs(Math.sin(t * 8)) * 0.12;
      rArm = -2.4 + Math.sin(t * 8) * 0.5;
      lArm = -2.4 - Math.sin(t * 8) * 0.5;
      root.current.rotation.y = ctl.yaw + Math.sin(t * 4) * 0.6;
    } else if (st === "celebrate") {
      bob = Math.abs(Math.sin(t * 9)) * 0.18;
      rArm = -2.7;
      lArm = -2.7;
    } else if (st === "wait") {
      headTilt = Math.sin(t * 1.5) * 0.1;
    } else if (st === "look") {
      headYaw = Math.sin(t * 1.3) * 0.65; // look around
    } else if (st === "browse") {
      lean = 0.1;
      headTilt = 0.16;
      headYaw = Math.sin(t * 0.8) * 0.5; // eyes along the shelf
      rArm = -0.35 + Math.max(0, Math.sin(t * 0.6)) * -0.5; // now and then points at a box
    } else if (st === "nod") {
      headPitch = Math.abs(Math.sin(e * 7)) * 0.32;
      lean = 0.06;
    } else if (st === "lookup") {
      headPitch = -0.32;
      headYaw = Math.sin(t * 0.7) * 0.25;
      rArm = -0.3;
      lArm = -0.3;
    } else if (st === "stretch") {
      const k = Math.sin(Math.min(1, e / 1.6) * Math.PI);
      rArm = -2.9 * k;
      lArm = -2.9 * k;
      rArmSide = -0.25 * k;
      lArmSide = 0.25 * k;
      lean = -0.12 * k;
      bob = 0.03 * k;
    } else if (st === "pose") {
      rArm = -2.3;
      rArmSide = -0.2;
      lArm = -0.25;
      lArmSide = 0.75;
      bodyRoll = 0.1;
    } else if (st === "spin") {
      spin = Math.min(1, e / 1.1) * Math.PI * 2 + (e > 1.1 ? Math.sin((e - 1.1) * 12) * 0.12 * Math.max(0, 1.4 - e) : 0);
      rArm = -1.4;
      lArm = -1.4;
      rArmSide = -1.1;
      lArmSide = 1.1;
    } else if (st === "surprise") {
      bob = Math.max(0, Math.sin(Math.min(1, e / 0.5) * Math.PI)) * 0.12;
      rArm = -2.0;
      lArm = -2.0;
      rArmSide = -0.9;
      lArmSide = 0.9;
      headPitch = -0.12;
    } else if (st === "think") {
      rArm = -2.1;
      rArmSide = 0.55; // hand to the chin
      headTilt = 0.22 + Math.sin(t * 1.2) * 0.05;
    } else if (st === "point") {
      rArm = -1.55;
      rArmSide = -0.15;
    } else if (st === "cheer") {
      // clapping in front of the chest
      const clap = Math.abs(Math.sin(t * 9));
      rArm = -1.35;
      lArm = -1.35;
      rArmSide = 0.15 + clap * 0.35;
      lArmSide = -0.15 - clap * 0.35;
      bob = Math.abs(Math.sin(t * 4.5)) * 0.04;
    }
    // FUN_YAWN: arms up, head back (sitting on the bench or standing)
    if (st === "yawn") {
      const k = Math.sin(Math.min(1, e / 1.8) * Math.PI);
      rArm = -2.6 * k - 0.9 * (1 - k);
      lArm = -2.6 * k - 0.9 * (1 - k);
      rArmSide = -0.3 * k;
      lArmSide = 0.3 * k;
      headPitch = -0.3 * k;
    }
    // turning on the spot: little steps
    if (st === "idle" && Math.abs(angleDiff(ctl.targetYaw, ctl.yaw)) > 0.35) legSwing = Math.sin(t * 12) * 0.25;
    // sitting on a cushion at the tea table: legs forward, hands on the table, a sip now and then
    let sit = 0;
    if (st === "yawn" && ctl.sittingOnBench) sit = 1;
    if (st === "standup") {
      // getting up from the bench / cushion
      sit = Math.max(0, 1 - e / 0.45);
      lean = 0.25 * sit;
      rArm = -0.6 * sit;
      lArm = -0.6 * sit;
    }
    if (st === "sit") {
      sit = 1;
      const sip = (t % 5) < 1.4 ? Math.sin(((t % 5) / 1.4) * Math.PI) : 0;
      rArm = -0.7 - sip * 1.2;
      rArmSide = -0.15 - sip * 0.25;
      lArm = -0.7;
      bob = 0;
      headTilt = sip * -0.08;
      if (ctl.sittingOnBench && !ctl.prop) {
        // resting on a bench: hands on the knees, legs swinging
        rArm = -0.9;
        lArm = -0.9;
        headTilt = Math.sin(t * 0.9) * 0.06;
      }
    }
    // bench seat is higher than the tea cushion
    body.current.position.y = bob - sit * (ctl.sittingOnBench ? -0.06 : 0.12);
    body.current.rotation.x = lean;
    body.current.rotation.z = bodyRoll;
    head.current.rotation.z = headTilt;
    head.current.rotation.y = headYaw;
    head.current.rotation.x = headPitch;
    if (spin) root.current.rotation.y = ctl.yaw + spin;
    armL.current.rotation.set(lArm, 0, lArmSide);
    armR.current.rotation.set(rArm, 0, rArmSide);
    const swing = sit && ctl.sittingOnBench ? Math.sin(t * 2.4) * 0.25 : 0;
    legL.current.rotation.x = sit ? -1.45 * sit + swing : legSwing;
    legR.current.rotation.x = sit ? -1.45 * sit - swing : -legSwing;
    cup.current.visible = ctl.prop === "cup";
    } // samplePose

    // ---- emote bubble beside the head (never over the name label)
    const em = ctl.emote?.icon ?? null;
    if (em !== emoteIcon.current) {
      emoteIcon.current = em;
      emoteMat.map = em ? emoteTexture(em) : null;
      emoteMat.needsUpdate = true;
    }
    emote.current.visible = !!em;
    if (em) {
      const pop = 1 + Math.max(0, Math.sin(t * 4)) * 0.06;
      emote.current.scale.set(0.32 * pop, 0.32 * pop, 1);
    }

    // ---- held product: slot → right hand → slot (always the commanding avatar's own hand)
    const held = ctl.held;
    const box = heldBox.current;
    if ((held?.productId ?? null) !== heldId) setHeldId(held?.productId ?? null);
    const hp = held ? products.get(held.productId) : undefined;
    if (held && hp) {
      const s = hp.box_size;
      hand.current.getWorldPosition(tmpHand);
      if (ctl.state === "show") {
        // present the box in front of the chest, front face towards the camera
        tmpHand.set(ctl.pos.x + Math.sin(ctl.yaw) * 0.34, 0.36 + bob, ctl.pos.z + Math.cos(ctl.yaw) * 0.34);
      }
      tmp.set(held.slot.x, held.slot.y + s.h / 2 + 0.025, held.slot.z);
      const k = ease(held.t);
      box.position.lerpVectors(tmp, tmpHand, k);
      // while presenting, turn the box gently left and right so viewers see its sides too
      const sway = ctl.state === "show" ? Math.sin(t * 0.9) * 0.45 : 0;
      box.rotation.set(0, (held.mode === "inHand" ? ctl.yaw : THREE.MathUtils.lerp(0, ctl.yaw, k)) + sway, 0);
      box.visible = true;
    } else {
      box.visible = false;
    }

    // ---- nickname label: constant on-screen size, always readable (never reduced by LOD)
    // close-up hygiene: other Chibis right in front of the lens are hidden, and the focused
    // Chibi's own label is dropped (the product card already names the viewer)
    const cv = clearView?.();
    root.current.visible = focused || (dist > 1.7 && !(cv && cv.keep !== ctl.info.avatar_id && dist < cv.dist));
    label.current.visible = !(focused && dist < 3.2);
    const sc = THREE.MathUtils.clamp(dist * 0.045, 0.34, 1.7);
    label.current.scale.set(sc * aspect * 0.42, sc * 0.42, 1);
  }, -1);

  const skin = toon(look.skin);
  const hairM = toon(look.hair);
  const shirt = toon(look.shirt);
  const pants = toon(look.pants);
  const eyeM = toon("#2b1d24");
  return (
    <>
      <group ref={root}>
        <mesh geometry={GEO.shadow} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
          <meshBasicMaterial color="#5a3040" transparent opacity={0.22} depthWrite={false} />
        </mesh>
        <group ref={body}>
          {/* legs */}
          <group ref={legL} position={[-0.08, 0.2, 0]}>
            <Part geometry={GEO.leg} material={pants} position={[0, -0.09, 0]} />
          </group>
          <group ref={legR} position={[0.08, 0.2, 0]}>
            <Part geometry={GEO.leg} material={pants} position={[0, -0.09, 0]} />
          </group>
          {/* torso */}
          <Part geometry={GEO.body} material={shirt} position={[0, 0.36, 0]} />
          {/* arms: pivot at the shoulder; hand socket at the end of the right arm */}
          <group ref={armL} position={[-0.2, 0.47, 0]}>
            <Part geometry={GEO.arm} material={shirt} position={[0, -0.13, 0]} />
            <Part geometry={GEO.hand} material={skin} position={[0, -0.26, 0]} />
            {/* REST_DRINK: a plain tea cup (not one of the shop's products) */}
            <group ref={cup} position={[0, -0.3, 0.06]} visible={false}>
              <mesh material={toon("#f3ead6")}>
                <cylinderGeometry args={[0.045, 0.035, 0.07, 14]} />
              </mesh>
              <mesh material={toon("#b9832f")} position={[0, 0.032, 0]}>
                <cylinderGeometry args={[0.04, 0.04, 0.006, 14]} />
              </mesh>
            </group>
          </group>
          <group ref={armR} position={[0.2, 0.47, 0]}>
            <Part geometry={GEO.arm} material={shirt} position={[0, -0.13, 0]} />
            <Part geometry={GEO.hand} material={skin} position={[0, -0.26, 0]} />
            <object3D ref={hand} name="rightHandSocket" position={[0, -0.27, 0.04]} />
          </group>
          {/* head */}
          <group ref={head} position={[0, 0.8, 0]}>
            <Part geometry={GEO.head} material={skin} />
            <Part geometry={GEO.hairCap} material={hairM} position={[0, 0.02, -0.01]} rotation={[-0.25, 0, 0]} outlineScale={1.03} />
            {look.hairStyle === 1 && (
              <>
                <Part geometry={GEO.bun} material={hairM} position={[-0.22, 0.22, -0.05]} />
                <Part geometry={GEO.bun} material={hairM} position={[0.22, 0.22, -0.05]} />
              </>
            )}
            {look.hairStyle === 2 && (
              <>
                <Part geometry={GEO.hairCap} material={toon("#ffffff")} position={[0, 0.05, 0]} scale={1.04} rotation={[-0.2, 0, 0]} outlineScale={1.03} />
                <Part geometry={GEO.capBrim} material={toon("#ffffff")} position={[0, 0.12, 0.22]} rotation={[0.25, 0, 0]} />
              </>
            )}
            {look.hairStyle === 3 &&
              [-0.15, 0, 0.15].map((x) => <Part key={x} geometry={GEO.spike} material={hairM} position={[x, 0.3, -0.02]} />)}
            {/* big shiny eyes + smile */}
            {[-1, 1].map((sx) => (
              <group key={sx} position={[sx * 0.1, -0.01, 0.262]}>
                <mesh geometry={GEO.eye} material={eyeM} scale={[1, 1.25, 0.6]} />
                <mesh geometry={GEO.eyeShine} material={WHITE} position={[0.014, 0.022, 0.03]} userData={{ detail: true }} />
              </group>
            ))}
            <mesh geometry={GEO.mouth} material={eyeM} position={[0, -0.1, 0.285]} rotation={[0, 0, Math.PI]} userData={{ detail: true }} />
            <mesh geometry={GEO.blush} position={[-0.17, -0.085, 0.247]} rotation={[0, -0.5, 0]} userData={{ detail: true }}>
              <meshBasicMaterial color="#ff7f9f" transparent opacity={0.55} depthWrite={false} />
            </mesh>
            <mesh geometry={GEO.blush} position={[0.17, -0.085, 0.247]} rotation={[0, 0.5, 0]} userData={{ detail: true }}>
              <meshBasicMaterial color="#ff7f9f" transparent opacity={0.55} depthWrite={false} />
            </mesh>
          </group>
        </group>
        <sprite ref={label} material={labelMat} position={[0, LABEL_Y, 0]} renderOrder={10} />
        <sprite ref={emote} material={emoteMat} position={[0.34, 1.12, 0]} renderOrder={11} visible={false} />
      </group>
      {/* the carried visual copy lives in world space so it can fly from the slot to the hand */}
      <group ref={heldBox} visible={false}>
        {heldProduct && <ProductVisual product={heldProduct} />}
      </group>
    </>
  );
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

const emoteCache = new Map<string, THREE.CanvasTexture>();
/** Small round bubble with an icon (♪ ★ ❤ ? ! i) shown beside a Chibi's head. */
function emoteTexture(icon: string): THREE.CanvasTexture {
  const hit = emoteCache.get(icon);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const colors: Record<string, string> = { "❤": "#e0455f", "★": "#e2a52b", "♪": "#3f6b3f", "?": "#4a6fa5", "!": "#c2502f", i: "#2e7a59" };
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(64, 60, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(40, 100);
  ctx.lineTo(28, 124);
  ctx.lineTo(62, 108);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = colors[icon] ?? "#3f6b3f";
  ctx.beginPath();
  ctx.arc(64, 60, 50, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = colors[icon] ?? "#3f6b3f";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${icon === "i" ? 70 : 64}px Georgia, "DejaVu Sans", sans-serif`;
  ctx.fillText(icon, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  emoteCache.set(icon, t);
  return t;
}

/** A body part with optional inverted-hull outline (cel-shaded look). */
export function Part({
  geometry, material, position, rotation, scale, outlineScale = 1.07,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  outlineScale?: number;
}) {
  // Chibis do not cast real-time shadows: the blob shadow under their feet is enough and
  // this halves their GPU cost (60 avatars × ~20 parts).
  const { outlines } = useContext(RenderContext);
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <mesh geometry={geometry} material={material} />
      {outlines && <mesh geometry={geometry} material={OUTLINE_MAT} scale={outlineScale} />}
    </group>
  );
}
