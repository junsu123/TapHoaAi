// Top-down store map editor (GAME-02 / PRD-02): drag shelves, rotate 90°, add, delete.
// Every change is validated by the server (inside the store, aisle gaps, door and counter
// clear, every stand point reachable from the door); a refused change snaps back.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, ApiError } from "../lib/api";

interface Pt {
  x: number;
  z: number;
}
interface EditorShelf {
  code: string;
  name: string;
  rot: number; // degrees
  transform: { x: number; z: number; w: number; d: number; rot: number };
  stand_positions: Pt[];
  wait_positions: Pt[];
  slots: { code: string; product_id: string | null }[];
}
interface StoreMap {
  store: { width: number; depth: number };
  counter: { x: number; z: number; w: number; d: number };
  door_zone: [number, number, number, number];
  min_gap: number;
  shelves: EditorShelf[];
}

const SNAP = 0.25;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

function footprint(s: { x: number; z: number; w: number; d: number }, rotDeg: number) {
  const quarter = rotDeg % 180 !== 0;
  const w = quarter ? s.d : s.w;
  const d = quarter ? s.w : s.d;
  return { x: s.x - w / 2, y: s.z - d / 2, w, d };
}

/** rot 0 → front faces +z (bottom of the map), 90 → +x, 180 → −z, 270 → −x. */
function frontEdge(f: { x: number; y: number; w: number; d: number }, rot: number) {
  const r = ((rot % 360) + 360) % 360;
  if (r === 0) return { x1: f.x, y1: f.y + f.d, x2: f.x + f.w, y2: f.y + f.d };
  if (r === 180) return { x1: f.x, y1: f.y, x2: f.x + f.w, y2: f.y };
  if (r === 90) return { x1: f.x + f.w, y1: f.y, x2: f.x + f.w, y2: f.y + f.d };
  return { x1: f.x, y1: f.y, x2: f.x, y2: f.y + f.d };
}

export function ShelfEditor({ onChanged }: { onChanged: () => void }) {
  const [map, setMap] = useState<StoreMap | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ code: string; x: number; z: number; dx: number; dz: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const load = useCallback(() => api.get<StoreMap>("/store/layout").then(setMap), []);
  useEffect(() => {
    load();
  }, [load]);

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current!;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const w = p.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: w.x, z: w.y };
  };

  const save = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const move = (code: string, x: number, z: number) => save(() => api.patch(`/shelves/${code}`, { x, z }));
  const shelf = map?.shelves.find((s) => s.code === selected) ?? null;

  const onPointerDown = (e: PointerEvent<SVGGElement>, s: EditorShelf) => {
    if (busy) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelected(s.code);
    const w = toWorld(e);
    setDrag({ code: s.code, x: s.transform.x, z: s.transform.z, dx: w.x - s.transform.x, dz: w.z - s.transform.z });
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const w = toWorld(e);
    setDrag({ ...drag, x: snap(w.x - drag.dx), z: snap(w.z - drag.dz) });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const s = map?.shelves.find((x) => x.code === drag.code);
    const moved = s && (s.transform.x !== drag.x || s.transform.z !== drag.z);
    const d = drag;
    setDrag(null);
    if (moved) move(d.code, d.x, d.z);
  };
  const onMapClick = (e: { clientX: number; clientY: number }) => {
    if (!adding || !map) return;
    setAdding(false);
    const w = toWorld(e);
    const used = new Set(map.shelves.map((s) => s.code));
    let n = 1;
    while (used.has(`KE_${String(n).padStart(2, "0")}`)) n++;
    const code = `KE_${String(n).padStart(2, "0")}`;
    save(() => api.post("/shelves", { code, name: `Kệ ${n}`, x: snap(w.x), z: snap(w.z), rot: 0 }));
  };
  const onKey = (e: KeyboardEvent<SVGGElement>, s: EditorShelf) => {
    if (busy) {
      e.preventDefault();
      return; // one change at a time: the next key waits for the server's answer
    }
    const step: Record<string, [number, number]> = { ArrowLeft: [-SNAP, 0], ArrowRight: [SNAP, 0], ArrowUp: [0, -SNAP], ArrowDown: [0, SNAP] };
    if (step[e.key]) {
      e.preventDefault();
      move(s.code, s.transform.x + step[e.key][0], s.transform.z + step[e.key][1]);
    } else if (e.key === "r" || e.key === "R") {
      save(() => api.patch(`/shelves/${s.code}`, { rot: (s.rot + 90) % 360 }));
    }
  };

  if (!map) return <p className="muted">Đang tải bản đồ…</p>;
  const W = map.store.width;
  const D = map.store.depth;
  const c = map.counter;
  const [dzx0, dzx1, dzz0, dzz1] = map.door_zone;
  return (
    <div className="editor-wrap">
      <div className="row wrap">
        <button className={adding ? "primary" : ""} onClick={() => setAdding(!adding)} disabled={busy}>
          {adding ? "Bấm vào bản đồ để đặt kệ…" : "+ Thêm kệ"}
        </button>
        <button disabled={!shelf || busy} onClick={() => shelf && save(() => api.patch(`/shelves/${shelf.code}`, { rot: (shelf.rot + 90) % 360 }))}>
          ⟳ Xoay 90°
        </button>
        <button
          disabled={!shelf || busy}
          onClick={() => {
            if (shelf && confirm(`Xóa ${shelf.name}? Sản phẩm trên kệ sẽ chưa có chỗ.`)) {
              setSelected(null);
              save(() => api.del(`/shelves/${shelf.code}`));
            }
          }}
        >
          Xóa kệ
        </button>
        <span className="muted">
          Kéo kệ để di chuyển (bước {SNAP} m) · chọn kệ rồi dùng phím mũi tên, phím R để xoay. Lối đi tối thiểu {map.min_gap} m.
        </span>
      </div>
      {err && (
        <p className="error" role="alert" data-testid="layout-error">
          {err}
        </p>
      )}
      <svg
        ref={svgRef}
        className="store-map"
        viewBox={`${-W / 2 - 0.3} ${-D / 2 - 0.3} ${W + 0.6} ${D + 0.6}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onMapClick}
        data-testid="store-map"
        style={{ cursor: adding ? "crosshair" : "default" }}
      >
        <rect x={-W / 2} y={-D / 2} width={W} height={D} className="map-floor" rx={0.2} />
        <rect x={dzx0} y={dzz0} width={dzx1 - dzx0} height={dzz1 - dzz0} className="map-door" />
        <text x={0} y={D / 2 - 0.35} className="map-text" textAnchor="middle">
          Cửa ra vào
        </text>
        <rect x={c.x - c.w / 2} y={c.z - c.d / 2} width={c.w} height={c.d} className="map-counter" rx={0.08} />
        <text x={c.x} y={c.z + 0.1} className="map-text" textAnchor="middle">
          Quầy
        </text>
        {map.shelves.map((s) => {
          const dragging = drag?.code === s.code;
          const pos = dragging ? { x: drag!.x, z: drag!.z } : { x: s.transform.x, z: s.transform.z };
          const f = footprint({ ...s.transform, ...pos }, s.rot);
          const hasProduct = s.slots.some((sl) => sl.product_id);
          return (
            <g
              key={s.code}
              role="button"
              tabIndex={0}
              aria-label={`${s.name}, x ${pos.x}, z ${pos.z}, xoay ${s.rot} độ`}
              aria-pressed={selected === s.code}
              data-testid={`shelf-${s.code}`}
              className={`map-shelf${selected === s.code ? " selected" : ""}${hasProduct ? " has-product" : ""}`}
              onPointerDown={(e) => onPointerDown(e, s)}
              onFocus={() => setSelected(s.code)}
              onKeyDown={(e) => onKey(e, s)}
            >
              <rect x={f.x} y={f.y} width={f.w} height={f.d} rx={0.06} />
              {/* front edge marker: the side customers stand at */}
              <line {...frontEdge(f, s.rot)} className="map-front" />
              <text x={pos.x} y={pos.z + 0.12} className="map-text" textAnchor="middle">
                {s.name}
              </text>
              {!dragging &&
                s.stand_positions.map((p, i) => <circle key={i} cx={p.x} cy={p.z} r={0.11} className="map-stand" />)}
            </g>
          );
        })}
      </svg>
      <p className="muted small">Chấm xanh: vị trí khách đứng lấy hàng. Vạch đậm: mặt trước của kệ. Kệ có viền hồng đang chứa sản phẩm.</p>
    </div>
  );
}
