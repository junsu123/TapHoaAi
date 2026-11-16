// BehaviorDebugOverlay (spec V3 §9): ?overlay=1 on the game page shows, above every Chibi, its
// top-level state, behaviour, target, queued direct commands and last failure, plus FPS and a
// count per state. Off by default; never shown on the LIVE output unless asked for.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import * as THREE from "three";
import type { GameEngine } from "./GameEngine";

const v = new THREE.Vector3();

/** Inside the Canvas: projects each Chibi's head to screen space for the overlay. */
export function DebugProjector({ engine }: { engine: GameEngine }) {
  const { camera } = useThree();
  useFrame(() => {
    const out = new Map<string, { x: number; y: number; on: boolean }>();
    for (const a of engine.avatars.values()) {
      v.set(a.pos.x, 1.55, a.pos.z).project(camera);
      out.set(a.info.avatar_id, { x: (v.x + 1) / 2, y: (1 - v.y) / 2, on: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 });
    }
    engine.debugScreens = out;
  });
  return null;
}

export function BehaviorDebugOverlay({ engine, fps }: { engine: GameEngine; fps: () => number[] }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);
  const avatars = [...engine.avatars.values()];
  const counts = new Map<string, number>();
  for (const a of avatars) counts.set(a.topState, (counts.get(a.topState) ?? 0) + 1);
  const f = fps();
  return (
    <div className="bdo" data-testid="behavior-debug">
      <div className="bdo-panel">
        <b>Chibi: {avatars.length}</b> · FPS {f.length ? f[f.length - 1] : "–"}
        <div>
          LOD {engine.lodLevel}: đủ {engine.lod.full} · giảm {engine.lod.reduced} · xa {engine.lod.far} · ngoài khung {engine.lod.hidden}
        </div>
        {engine.hostSpeaking && <div>🔊 đang đọc: bớt trò vui</div>}
        {engine.clips.warnings.length > 0 && <div>clip thay thế: {engine.clips.warnings.join(", ")}</div>}
        {[...counts.entries()].sort().map(([k, n]) => (
          <div key={k}>
            {k}: {n}
          </div>
        ))}
      </div>
      {avatars.map((a) => {
        const p = engine.debugScreens.get(a.info.avatar_id);
        if (!p?.on) return null;
        const target = a.cmd ? `${a.cmd.product_id} @${a.cmd.shelf_id}` : a.heading ? `→ ${a.heading.x.toFixed(1)},${a.heading.z.toFixed(1)}` : "";
        return (
          <div key={a.info.avatar_id} className={`bdo-tag ${a.lastFailure ? "fail" : ""}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} data-avatar={a.info.avatar_id}>
            <div className="bdo-state">{a.topState}</div>
            <div>{a.behaviorId}</div>
            {target && <div>{target}</div>}
            {a.direct.length > 0 && <div>q: {a.direct.map((d) => d.kind).join(",")}</div>}
            {a.lastFailure && <div>✖ {a.lastFailure}</div>}
          </div>
        );
      })}
    </div>
  );
}
