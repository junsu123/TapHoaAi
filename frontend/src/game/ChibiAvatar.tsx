// Procedural Chibi (M1): big head, small body, right-hand socket. Reads its controller every
// frame through refs, so React does not re-render per frame. M2 swaps in GLB models with a
// shared skeleton, keeping the `rightHandSocket` contract.

import { useFrame, useThree } from "@react-three/fiber";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ProductInfo } from "../types/protocol";
import type { AvatarController } from "./AvatarController";
import { appearanceFromSeed, GEO, LabelRegistryContext, OUTLINE_MAT, RenderContext, toon, WHITE } from "./palette";
import { ProductVisual } from "./ProductBox";
import { nameTexture } from "./nameTexture";

const tmp = new THREE.Vector3();
const tmpHand = new THREE.Vector3();
const ease = (t: number) => t * t * (3 - 2 * t);
const LABEL_Y = 1.42;
const OUTLINE_LOD_DISTANCE = 12;

export function ChibiAvatar({ ctl, products, focusedId }: { ctl: AvatarController; products: Map<string, ProductInfo>; focusedId: () => string | null }) {
  const root = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const armL = useRef<THREE.Group>(null!);
  const armR = useRef<THREE.Group>(null!);
  const legL = useRef<THREE.Group>(null!);
  const legR = useRef<THREE.Group>(null!);
  const hand = useRef<THREE.Object3D>(null!); // rightHandSocket
  const label = useRef<THREE.Sprite>(null!);
  const heldBox = useRef<THREE.Group>(null!);
  const { camera } = useThree();
  const labels = useContext(LabelRegistryContext);
  const outlineMeshes = useRef<THREE.Object3D[]>([]);
  const outlinesOn = useRef(true);

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
  // collect outline meshes once (and whenever the look changes) for distance LOD
  useEffect(() => {
    const found: THREE.Object3D[] = [];
    root.current.traverse((o) => {
      if ((o as THREE.Mesh).material === OUTLINE_MAT) found.push(o);
    });
    outlineMeshes.current = found;
    outlinesOn.current = true;
  }, [look]);

  useFrame((state) => {
    const t = state.clock.elapsedTime + (ctl.info.appearance_seed % 100) * 0.1;
    const st = ctl.state;
    root.current.position.set(ctl.pos.x, 0, ctl.pos.z);
    root.current.rotation.y = ctl.yaw;

    // ---- procedural animation per FSM state
    let bob = Math.sin(t * 2.2) * 0.01;
    let lArm = 0.15;
    let rArm = 0.15;
    let rArmSide = -0.12;
    let lArmSide = 0.12;
    let legSwing = 0;
    let headTilt = 0;
    let lean = 0;
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
    }
    body.current.position.y = bob;
    body.current.rotation.x = lean;
    head.current.rotation.z = headTilt;
    armL.current.rotation.set(lArm, 0, lArmSide);
    armR.current.rotation.set(rArm, 0, rArmSide);
    legL.current.rotation.x = legSwing;
    legR.current.rotation.x = -legSwing;

    // ---- held product: slot → right hand → slot (always the commanding avatar's own hand)
    const held = ctl.held;
    const box = heldBox.current;
    if ((held?.productId ?? null) !== heldId) setHeldId(held?.productId ?? null);
    const hp = held ? products.get(held.productId) : undefined;
    if (held && hp) {
      const s = hp.box_size;
      hand.current.getWorldPosition(tmpHand);
      if (st === "show") {
        // present the box in front of the chest, front face towards the camera
        tmpHand.set(ctl.pos.x + Math.sin(ctl.yaw) * 0.34, 0.36 + bob, ctl.pos.z + Math.cos(ctl.yaw) * 0.34);
      }
      tmp.set(held.slot.x, held.slot.y + s.h / 2 + 0.025, held.slot.z);
      const k = ease(held.t);
      box.position.lerpVectors(tmp, tmpHand, k);
      box.rotation.set(0, held.mode === "inHand" ? ctl.yaw : THREE.MathUtils.lerp(0, ctl.yaw, k), 0);
      box.visible = true;
    } else {
      box.visible = false;
    }

    // ---- nickname label: constant on-screen size, always readable
    const dist = camera.position.distanceTo(root.current.position);
    // close-up hygiene: other Chibis right in front of the lens are hidden, and the focused
    // Chibi's own label is dropped (the product card already names the viewer)
    const focused = focusedId() === ctl.info.avatar_id;
    root.current.visible = focused || dist > 1.7;
    // outline LOD: far-away Chibis are a few pixels tall — skip their outline draw calls
    const wantOutlines = dist < OUTLINE_LOD_DISTANCE;
    if (wantOutlines !== outlinesOn.current) {
      outlinesOn.current = wantOutlines;
      for (const o of outlineMeshes.current) o.visible = wantOutlines;
    }
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
                <mesh geometry={GEO.eyeShine} material={WHITE} position={[0.014, 0.022, 0.03]} />
              </group>
            ))}
            <mesh geometry={GEO.mouth} material={eyeM} position={[0, -0.1, 0.285]} rotation={[0, 0, Math.PI]} />
            <mesh geometry={GEO.blush} position={[-0.17, -0.085, 0.247]} rotation={[0, -0.5, 0]}>
              <meshBasicMaterial color="#ff7f9f" transparent opacity={0.55} depthWrite={false} />
            </mesh>
            <mesh geometry={GEO.blush} position={[0.17, -0.085, 0.247]} rotation={[0, 0.5, 0]}>
              <meshBasicMaterial color="#ff7f9f" transparent opacity={0.55} depthWrite={false} />
            </mesh>
          </group>
        </group>
        <sprite ref={label} material={labelMat} position={[0, LABEL_Y, 0]} renderOrder={10} />
      </group>
      {/* the carried visual copy lives in world space so it can fly from the slot to the hand */}
      <group ref={heldBox} visible={false}>
        {heldProduct && <ProductVisual product={heldProduct} />}
      </group>
    </>
  );
}

/** A body part with optional inverted-hull outline (cel-shaded look). */
function Part({
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
