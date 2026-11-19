// The tea corner: a low table with two cushions, a clay teapot and cups, and the shop-owner
// Chibi who brews tea, stands up and bows to greet, and pours tea for gift givers.

import { useFrame, useThree } from "@react-three/fiber";
import { useContext, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { GameEngine } from "./GameEngine";
import { Part } from "./ChibiAvatar";
import { nameTexture } from "./nameTexture";
import { GEO, LabelRegistryContext, RenderContext, toon } from "./palette";
import { BANG_OFFSET, bangsMat, CHIBI_SCALE as S, chibiMat, faceMat, LOOK_GEO, shadowMat, type Expression } from "./chibiLook";
import type { TeaSpot } from "./teahouse";

const tmp = new THREE.Vector3();
const LABEL_Y = 1.42 * S;
const OWNER_EYES = "#4a2c1e";

export function TeaCorner({ engine, spot }: { engine: GameEngine; spot: TeaSpot }) {
  const { shadows } = useContext(RenderContext);
  const { table } = spot;
  const top = 0.34;
  const cupFull = useRef<THREE.Mesh>(null!);
  const pot = useRef<THREE.Group>(null!);
  const steam = useRef<THREE.Group>(null!);
  const ownerCup = useMemo(() => ({ x: table.x - 0.3, z: table.z + 0.12 }), [table]);
  const guestCup = useMemo(() => ({ x: table.x + 0.14, z: table.z + 0.12 }), [table]);
  const potRest = useMemo(() => new THREE.Vector3(table.x - 0.26, top + 0.1, table.z - 0.14), [table]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const tea = engine.tea;
    // teapot: rests on the table; lifts and tilts to pour — into the owner's own cup while
    // brewing (every few seconds), into the guest's cup while serving
    const serving = tea.pose === "serve";
    const brewPour = tea.pose === "brew" && t % 7 < 1.6;
    const pouring = serving || brewPour;
    const target = serving ? guestCup : ownerCup;
    const k = pouring ? Math.min(1, serving ? tea.poseT / 0.6 : (t % 7) / 0.4) : 0;
    pot.current.position.set(
      THREE.MathUtils.lerp(potRest.x, target.x - 0.1 * Math.sign(target.x - potRest.x || 1), k),
      THREE.MathUtils.lerp(potRest.y, top + 0.32, k),
      THREE.MathUtils.lerp(potRest.z, target.z, k),
    );
    const dir = target.x >= potRest.x ? -1 : 1;
    pot.current.rotation.set(0, 0, pouring ? dir * 0.75 * k : 0);
    cupFull.current.visible = tea.guestCupFull || (serving && tea.poseT > 1.2);
    // steam from the pot
    steam.current.children.forEach((c, i) => {
      const p = ((t * 0.35 + i / 3) % 1);
      c.position.set(Math.sin(t + i) * 0.03, 0.18 + p * 0.35, 0);
      (c as THREE.Mesh).scale.setScalar(0.5 + p);
      ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - p);
    });
  });

  const wood = toon("#6b4424");
  const woodTop = toon("#8a5a34");
  const cushionA = toon("#c98a3a");
  const cushionB = toon("#5f8a4a");
  const cup = toon("#f3ead6");
  const clay = toon("#8b4a2b");
  return (
    <group>
      {/* low table */}
      <group position={[table.x, 0, table.z]}>
        <mesh material={woodTop} position={[0, top, 0]} castShadow={shadows} receiveShadow={shadows}>
          <boxGeometry args={[spot.tableW, 0.05, spot.tableD]} />
        </mesh>
        <mesh material={toon("#e6cf98")} position={[0, top + 0.03, 0]}>
          <boxGeometry args={[spot.tableW * 0.62, 0.012, spot.tableD * 0.55]} />
        </mesh>
        {[
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ].map(([sx, sz]) => (
          <mesh key={`${sx}${sz}`} material={wood} position={[(sx * spot.tableW) / 2.4, top / 2, (sz * spot.tableD) / 2.6]}>
            <boxGeometry args={[0.06, top, 0.06]} />
          </mesh>
        ))}
      </group>
      {/* cushions */}
      {[
        [spot.owner, cushionA],
        [spot.guest, cushionB],
      ].map(([p, m], i) => (
        <mesh key={i} material={m as THREE.Material} position={[(p as { x: number }).x, 0.05, (p as { z: number }).z]} castShadow={shadows}>
          <cylinderGeometry args={[0.24, 0.26, 0.1, 24]} />
        </mesh>
      ))}
      {/* cups */}
      {[ownerCup, guestCup].map((c, i) => (
        <group key={i} position={[c.x, top + 0.06, c.z]}>
          <mesh material={cup}>
            <cylinderGeometry args={[0.045, 0.034, 0.07, 16]} />
          </mesh>
          {i === 1 && (
            <mesh ref={cupFull} material={toon("#b9832f")} position={[0, 0.032, 0]} visible={false}>
              <cylinderGeometry args={[0.04, 0.04, 0.008, 16]} />
            </mesh>
          )}
        </group>
      ))}
      {/* clay teapot */}
      <group ref={pot}>
        <mesh material={clay} scale={[1, 0.8, 1]} castShadow={shadows}>
          <sphereGeometry args={[0.1, 20, 14]} />
        </mesh>
        <mesh material={clay} position={[0.12, 0.02, 0]} rotation={[0, 0, -0.9]}>
          <cylinderGeometry args={[0.013, 0.022, 0.1, 8]} />
        </mesh>
        <mesh material={toon("#6e3a20")} position={[0, 0.09, 0]}>
          <sphereGeometry args={[0.03, 10, 8]} />
        </mesh>
        <mesh material={toon("#6e3a20")} position={[-0.11, 0.01, 0]} rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.045, 0.012, 6, 14, Math.PI]} />
        </mesh>
        <group ref={steam}>
          {[0, 1, 2].map((i) => (
            <mesh key={i}>
              <sphereGeometry args={[0.03, 10, 8]} />
              <meshBasicMaterial color="#ffffff" transparent opacity={0.3} depthWrite={false} />
            </mesh>
          ))}
        </group>
      </group>
      <OwnerChibi engine={engine} spot={spot} />
    </group>
  );
}

/** The shop owner: tea-green shirt, cream apron, hair in a bun. */
function OwnerChibi({ engine, spot }: { engine: GameEngine; spot: TeaSpot }) {
  const root = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const armL = useRef<THREE.Group>(null!);
  const armR = useRef<THREE.Group>(null!);
  const legL = useRef<THREE.Group>(null!);
  const legR = useRef<THREE.Group>(null!);
  const label = useRef<THREE.Sprite>(null!);
  const face = useRef<THREE.Mesh>(null!);
  const stand = useRef(0);
  const { camera } = useThree();
  const labels = useContext(LabelRegistryContext);
  const name = engine.scene.owner_name || "Chủ quán";
  const { texture, aspect } = useMemo(() => nameTexture(name, false), [name]);
  const labelMat = useMemo(() => new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }), [texture]);
  useEffect(() => () => labelMat.dispose(), [labelMat]);
  useEffect(() => {
    labels?.set("__owner", { sprite: label.current, baseY: LABEL_Y, aspect });
    return () => {
      labels?.delete("__owner");
    };
  }, [labels, aspect]);

  useFrame((state, dt) => {
    const tea = engine.tea;
    const t = state.clock.elapsedTime;
    stand.current = THREE.MathUtils.lerp(stand.current, tea.standing(), 1 - Math.exp(-dt * 12));
    const s = stand.current;
    const bow = tea.bowAngle();
    root.current.position.set(spot.owner.x, 0, spot.owner.z);
    // standing up to greet: turn towards the viewers (the main camera looks along −z)
    root.current.rotation.y = THREE.MathUtils.lerp(spot.ownerYaw, 0.25, s);
    body.current.position.y = -0.08 * (1 - s);
    body.current.rotation.x = bow;
    legL.current.rotation.x = -1.45 * (1 - s);
    legR.current.rotation.x = -1.45 * (1 - s);
    let rArm = -0.9;
    let rSide = -0.15;
    let lArm = -0.65;
    let lSide = 0.15;
    if (tea.pose === "brew" && tea.talking) {
      // talking to the viewers: an open hand moving with the words, a little nod
      rArm = -1.05 + Math.sin(t * 3.1) * 0.22;
      rSide = -0.35 - Math.max(0, Math.sin(t * 1.7)) * 0.25;
      lArm = -0.7;
    } else if (tea.pose === "brew") {
      const pour = t % 7 < 1.6;
      rArm = pour ? -1.25 : -0.85 + Math.sin(t * 1.3) * 0.05;
      lArm = -0.7;
    } else if (tea.pose === "serve") {
      rArm = -1.3;
      rSide = -0.35;
    } else if (tea.pose === "offer") {
      rArm = -1.15;
      rSide = -0.7; // open hand towards the guest: "mời"
      lArm = -0.4;
    } else if (s > 0.3) {
      // hands together in front while bowing / standing
      rArm = -0.35;
      lArm = -0.35;
      rSide = 0.32;
      lSide = -0.32;
    }
    armL.current.rotation.set(lArm, 0, lSide);
    armR.current.rotation.set(rArm, 0, rSide);
    head.current.rotation.x = bow * 0.3 + (tea.talking ? Math.sin(t * 5.2) * 0.05 : 0);
    head.current.rotation.y = tea.talking ? Math.sin(t * 0.9) * 0.18 : 0;
    // face: eyes smile shut while bowing, the mouth moves with the words, a blink now and then
    const ex: Expression = {
      eyes: bow > 0.15 ? "happy" : (t + 1.3) % 3.7 < 0.13 ? "closed" : "open",
      mouth: tea.talking ? (Math.sin(t * 11) > 0.1 ? "grin" : "smile") : s > 0.3 ? "grin" : "smile",
    };
    const fm = faceMat(OWNER_EYES, ex);
    if (face.current.material !== fm) face.current.material = fm;
    const dist = camera.position.distanceTo(root.current.position);
    const sc = THREE.MathUtils.clamp(dist * 0.045, 0.34, 1.7);
    label.current.scale.set(sc * aspect * 0.42, sc * 0.42, 1);
    // where the speech bubble goes: just above the head, in screen space (0..1)
    root.current.getWorldPosition(tmp);
    tmp.y += (1.2 - 0.08 * (1 - s)) * S;
    tmp.project(camera);
    engine.ownerScreen = { x: (tmp.x + 1) / 2, y: (1 - tmp.y) / 2, visible: tmp.z < 1 && Math.abs(tmp.x) < 1.2 };
  }, -1);

  const skin = chibiMat("#ffd9c2");
  const hairC = "#2b1d1a";
  const hair = chibiMat(hairC);
  const shirt = chibiMat("#3f6b3f");
  const apron = chibiMat("#f3ead6");
  const pants = chibiMat("#4a3426");
  const shoe = chibiMat("#5a3a26");
  return (
    <group ref={root}>
      <group scale={S}>
      <mesh geometry={GEO.shadow} material={shadowMat("#3a2a1a", 0.3)} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]} />
      <group ref={body}>
        {[-1, 1].map((sx) => (
          <group key={sx} ref={sx < 0 ? legL : legR} position={[sx * 0.08, 0.2, 0]}>
            <Part geometry={GEO.leg} material={pants} position={[0, -0.09, 0]} />
            <group position={[0, -0.158, 0.03]} scale={[1, 0.62, 1.35]}>
              <Part geometry={LOOK_GEO.shoe} material={shoe} outlineScale={1.1} />
            </group>
          </group>
        ))}
        <Part geometry={GEO.body} material={shirt} position={[0, 0.36, 0]} />
        <Part geometry={LOOK_GEO.hips} material={pants} position={[0, 0.245, 0]} outlineScale={1.05} />
        {/* apron */}
        <mesh material={apron} position={[0, 0.33, 0.155]} rotation={[-0.08, 0, 0]}>
          <boxGeometry args={[0.24, 0.28, 0.02]} />
        </mesh>
        <mesh material={toon("#c49a62")} position={[0, 0.46, 0.17]}>
          <boxGeometry args={[0.3, 0.025, 0.02]} />
        </mesh>
        {/* a little tea leaf on the apron */}
        <mesh material={toon("#5f8a4a")} position={[0.05, 0.3, 0.167]} rotation={[0, 0, 0.6]} scale={[1, 0.55, 1]}>
          <circleGeometry args={[0.035, 16]} />
        </mesh>
        <group ref={armL} position={[-0.2, 0.47, 0]}>
          <Part geometry={GEO.arm} material={shirt} position={[0, -0.13, 0]} />
          <Part geometry={GEO.hand} material={skin} position={[0, -0.26, 0]} />
        </group>
        <group ref={armR} position={[0.2, 0.47, 0]}>
          <Part geometry={GEO.arm} material={shirt} position={[0, -0.13, 0]} />
          <Part geometry={GEO.hand} material={skin} position={[0, -0.26, 0]} />
        </group>
        <group ref={head} position={[0, 0.8, 0]}>
          <Part geometry={GEO.head} material={skin} />
          <mesh ref={face} geometry={LOOK_GEO.face} material={faceMat(OWNER_EYES, { eyes: "open", mouth: "smile" })} renderOrder={1} />
          <Part geometry={GEO.hairCap} material={hair} position={BANG_OFFSET} rotation={[-0.53, 0, 0]} outlineScale={1.03} />
          <mesh geometry={LOOK_GEO.bangs} material={bangsMat(hairC)} position={BANG_OFFSET} />
          <Part geometry={GEO.bun} material={hair} position={[0, 0.3, -0.12]} scale={1.15} />
          <mesh material={toon("#e2b437")} position={[0.06, 0.34, -0.1]} rotation={[0.3, 0, 0.9]}>
            <cylinderGeometry args={[0.008, 0.008, 0.26, 6]} />
          </mesh>
        </group>
      </group>
      </group>
      <sprite ref={label} material={labelMat} position={[0, LABEL_Y, 0]} renderOrder={10} />
    </group>
  );
}
