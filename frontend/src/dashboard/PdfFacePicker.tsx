// Take every face of the product box from the shop's print PDF.
//
// The owner uploads the print file (usually the unfolded box "dieline" at real size, sometimes
// one page per face). Each face gets a frame sized from the real box size in cm, already laid
// out like a standard dieline; the owner drags the frames onto the right panels, turns any that
// are printed sideways, and the server renders each framed area at texture resolution.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { ProductInfo } from "../types/protocol";

const BoxPreview3D = lazy(() => import("./BoxPreview3D"));

export type BoxFace = "front" | "back" | "left" | "right" | "top" | "bottom";
export const BOX_FACES: BoxFace[] = ["front", "back", "left", "right", "top", "bottom"];
export const BOX_FACE_LABEL: Record<BoxFace, string> = {
  front: "Mặt trước",
  back: "Mặt sau",
  left: "Mặt bên trái",
  right: "Mặt bên phải",
  top: "Nắp trên",
  bottom: "Đáy",
};
const FACE_COLOR: Record<BoxFace, string> = {
  front: "#e2557b",
  back: "#7a5af5",
  left: "#1f9d8a",
  right: "#e08a1e",
  top: "#2f7de1",
  bottom: "#8a6d3b",
};

export interface RenderedFace {
  id: number;
  url: string;
  width: number;
  height: number;
}
export type RenderedFaces = Partial<Record<BoxFace, RenderedFace>>;

interface PdfPage {
  index: number;
  width_pt: number;
  height_pt: number;
  preview_url: string;
}
interface Frame {
  on: boolean;
  page: number;
  x: number; // points, top-left origin of the displayed page
  y: number;
  w: number;
  h: number;
  rotate: 0 | 90 | 180 | 270; // clockwise turn that makes the printed face upright
}
type Frames = Record<BoxFace, Frame>;
export interface BoxCm {
  w: string;
  h: string;
  d: string;
}

const PT_PER_CM = 72 / 2.54;

/** Upright size of each face in points. */
export function faceSizePt(face: BoxFace, cm: { w: number; h: number; d: number }): [number, number] {
  const [w, h, d] = [cm.w * PT_PER_CM, cm.h * PT_PER_CM, cm.d * PT_PER_CM];
  if (face === "front" || face === "back") return [w, h];
  if (face === "left" || face === "right") return [d, h];
  return [w, d];
}

function onPage(size: [number, number], rotate: number): [number, number] {
  return rotate % 180 === 0 ? size : [size[1], size[0]];
}

/** Content bounds of a page preview (non-white pixels), in points. */
function contentBox(img: HTMLImageElement, page: PdfPage): { x0: number; y0: number; x1: number; y1: number } {
  const full = { x0: 0, y0: 0, x1: page.width_pt, y1: page.height_pt };
  const W = 400;
  const H = Math.max(1, Math.round((W * img.naturalHeight) / img.naturalWidth));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return full;
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  let [x0, y0, x1, y1] = [W, H, -1, -1];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  if (x1 < 0) return full;
  const k = page.width_pt / W;
  return { x0: x0 * k, y0: y0 * k, x1: (x1 + 1) * k, y1: (y1 + 1) * k };
}

/**
 * First guess. Several pages whose size matches a face: one page per face. Otherwise a
 * standard tuck-end dieline on the first page — [left][front][right][back] in a row, the
 * top flap above the front panel, the bottom flap below it — placed on the printed area.
 */
export function initialFrames(pages: PdfPage[], cm: { w: number; h: number; d: number }, content: { x0: number; y0: number; x1: number; y1: number } | null): Frames {
  const out = {} as Frames;
  const used = new Set<number>();
  if (pages.length > 1) {
    for (const face of BOX_FACES) {
      const [fw, fh] = faceSizePt(face, cm);
      const near = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) < 0.15;
      const hit = pages.find((p) => !used.has(p.index) && ((near(p.width_pt, fw) && near(p.height_pt, fh)) || (near(p.width_pt, fh) && near(p.height_pt, fw))));
      if (hit) {
        used.add(hit.index);
        const sideways = !(near(hit.width_pt, fw) && near(hit.height_pt, fh));
        out[face] = { on: true, page: hit.index, x: 0, y: 0, w: hit.width_pt, h: hit.height_pt, rotate: sideways ? 90 : 0 };
      }
    }
    if (BOX_FACES.every((f) => out[f])) return out;
  }
  const p0 = pages[0];
  const b = content ?? { x0: 0, y0: 0, x1: p0.width_pt, y1: p0.height_pt };
  const [W, H, D] = [cm.w * PT_PER_CM, cm.h * PT_PER_CM, cm.d * PT_PER_CM];
  const stripW = 2 * W + 2 * D;
  const left = b.x1 - b.x0 > stripW ? b.x0 : (b.x0 + b.x1) / 2 - stripW / 2;
  const top = (b.y0 + b.y1) / 2 - H / 2;
  const guess: Record<BoxFace, [number, number, number, number]> = {
    left: [left, top, D, H],
    front: [left + D, top, W, H],
    right: [left + D + W, top, D, H],
    back: [left + 2 * D + W, top, W, H],
    top: [left + D, top - D, W, D],
    bottom: [left + D, top + H, W, D],
  };
  for (const face of BOX_FACES) {
    if (out[face]) continue;
    const [x, y, w, h] = guess[face];
    out[face] = { on: true, page: 0, x, y, w, h, rotate: 0 };
  }
  return out;
}

/**
 * Neighbouring panels of a box share a fold line, so a dragged frame snaps its edges to the
 * edges of the other frames on the same page (touching or aligned) within `tol` points.
 */
export function snap(face: BoxFace, fr: Frame, x: number, y: number, frames: Frames, tol: number): { x: number; y: number } {
  let [bx, by] = [tol, tol];
  let [sx, sy] = [x, y];
  for (const f of BOX_FACES) {
    const o = frames[f];
    if (f === face || !o.on || o.page !== fr.page) continue;
    for (const target of [o.x, o.x + o.w]) {
      for (const cand of [target, target - fr.w]) {
        const dist = Math.abs(x - cand);
        if (dist < bx) [bx, sx] = [dist, cand];
      }
    }
    for (const target of [o.y, o.y + o.h]) {
      for (const cand of [target, target - fr.h]) {
        const dist = Math.abs(y - cand);
        if (dist < by) [by, sy] = [dist, cand];
      }
    }
  }
  return { x: sx, y: sy };
}

/** What the frame will produce, drawn from the page preview (for the side list). */
function useThumb(img: HTMLImageElement | undefined, page: PdfPage | undefined, fr: Frame): string | null {
  return useMemo(() => {
    if (!img || !page || !img.complete || !img.naturalWidth) return null;
    const k = img.naturalWidth / page.width_pt;
    const sw = fr.w * k;
    const sh = fr.h * k;
    const upright = fr.rotate % 180 === 0 ? [sw, sh] : [sh, sw];
    const scale = 96 / Math.max(upright[0], upright[1]);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(upright[0] * scale));
    c.height = Math.max(1, Math.round(upright[1] * scale));
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((fr.rotate * Math.PI) / 180);
    ctx.drawImage(img, fr.x * k, fr.y * k, sw, sh, (-sw * scale) / 2, (-sh * scale) / 2, sw * scale, sh * scale);
    return c.toDataURL("image/png");
  }, [img, page, fr.x, fr.y, fr.w, fr.h, fr.rotate]);
}

function FaceRow(props: {
  face: BoxFace;
  fr: Frame;
  pages: PdfPage[];
  img: HTMLImageElement | undefined;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Frame>) => void;
  onRotate: () => void;
}) {
  const { face, fr, pages, img, selected } = props;
  const thumb = useThumb(img, pages[fr.page], fr);
  return (
    <div className={`face-row${selected ? " sel" : ""}${fr.on ? "" : " off"}`} onClick={props.onSelect} data-testid={`face-row-${face}`}>
      <span className="face-dot" style={{ background: FACE_COLOR[face] }} />
      <label className="check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={fr.on} onChange={(e) => props.onChange({ on: e.target.checked })} aria-label={`Dùng ${BOX_FACE_LABEL[face]}`} />
        {BOX_FACE_LABEL[face]}
      </label>
      {pages.length > 1 && (
        <select value={fr.page} onClick={(e) => e.stopPropagation()} onChange={(e) => props.onChange({ page: Number(e.target.value) })} aria-label={`Trang của ${BOX_FACE_LABEL[face]}`}>
          {pages.map((p) => (
            <option key={p.index} value={p.index}>
              Trang {p.index + 1}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="small"
        title="Xoay 90° nếu mặt này in nằm ngang hoặc ngược"
        aria-label={`Xoay ${BOX_FACE_LABEL[face]}`}
        onClick={(e) => {
          e.stopPropagation();
          props.onRotate();
        }}
      >
        ⟳ {fr.rotate}°
      </button>
      <span className="face-thumb">{thumb && fr.on ? <img src={thumb} alt="" /> : null}</span>
    </div>
  );
}

export function PdfFacePicker(props: {
  cm: BoxCm;
  setCm: (cm: BoxCm) => void;
  boxColor: string;
  onApply: (faces: RenderedFaces) => void;
  onClose: () => void;
}) {
  const { cm, setCm } = props;
  const dims = { w: Number(cm.w), h: Number(cm.h), d: Number(cm.d) };
  const dimsOk = dims.w > 0 && dims.h > 0 && dims.d > 0;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ id: string; pages: PdfPage[] } | null>(null);
  const [imgs, setImgs] = useState<Record<number, HTMLImageElement>>({});
  const [pageIdx, setPageIdx] = useState(0);
  const [frames, setFrames] = useState<Frames | null>(null);
  const [sel, setSel] = useState<BoxFace>("front");
  const [zoom, setZoom] = useState(1);
  const [result, setResult] = useState<RenderedFaces | null>(null);
  const touched = useRef(false); // the owner has moved, resized or turned a frame
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(720);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  useEffect(() => {
    const el = stageRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageW(Math.max(320, el.clientWidth - 4)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc, frames === null, result === null]);

  // load every page preview once
  useEffect(() => {
    if (!doc) return;
    for (const p of doc.pages) {
      const im = new Image();
      im.onload = () => setImgs((m) => ({ ...m, [p.index]: im }));
      im.src = p.preview_url;
    }
  }, [doc]);

  // first layout once page 1 is visible and the size is known
  useEffect(() => {
    if (!doc || frames || !dimsOk || !imgs[0]) return;
    setFrames(initialFrames(doc.pages, dims, contentBox(imgs[0], doc.pages[0])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, imgs, dimsOk, frames]);

  // a new real size resizes every frame around its centre
  const dimsKey = `${cm.w}|${cm.h}|${cm.d}`;
  const lastDims = useRef(dimsKey);
  useEffect(() => {
    if (lastDims.current === dimsKey) return;
    lastDims.current = dimsKey;
    if (!frames || !dimsOk || !doc) return;
    if (!touched.current) {
      setFrames(initialFrames(doc.pages, dims, imgs[0] ? contentBox(imgs[0], doc.pages[0]) : null));
      return;
    }
    const next = { ...frames };
    for (const f of BOX_FACES) {
      const fr = next[f];
      if (doc.pages.length > 1 && fr.x === 0 && fr.y === 0) continue; // whole-page faces keep the page
      const [w, h] = onPage(faceSizePt(f, dims), fr.rotate);
      next[f] = { ...fr, x: fr.x + fr.w / 2 - w / 2, y: fr.y + fr.h / 2 - h / 2, w, h };
    }
    setFrames(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimsKey]);

  const upload = async (file: File) => {
    setErr(null);
    setBusy("Đang đọc file PDF…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const d = await api.upload<{ id: string; pages: PdfPage[] }>("/pdf-imports", fd);
      setImgs({});
      setFrames(null);
      setResult(null);
      touched.current = false;
      setPageIdx(0);
      setDoc(d);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(null);
    }
  };

  const patch = useCallback((face: BoxFace, p: Partial<Frame>) => {
    touched.current = true;
    setFrames((fs) => (fs ? { ...fs, [face]: { ...fs[face], ...p } } : fs));
  }, []);
  const rotate = (face: BoxFace) => {
    if (!frames) return;
    const fr = frames[face];
    const r = ((fr.rotate + 90) % 360) as Frame["rotate"];
    // the frame on the page turns with the print: swap its sides around the centre
    const [w, h] = [fr.h, fr.w];
    patch(face, { rotate: r, x: fr.x + fr.w / 2 - w / 2, y: fr.y + fr.h / 2 - h / 2, w, h });
  };

  const page = doc?.pages[pageIdx];
  const scale = page ? (stageW * zoom) / page.width_pt : 1;

  // drag a frame (move) or its corner (resize, keeping the real proportions)
  const drag = useRef<{ face: BoxFace; mode: "move" | "size"; sx: number; sy: number; fr: Frame } | null>(null);
  const onDown = (face: BoxFace, mode: "move" | "size") => (e: RPointerEvent) => {
    if (!frames) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel(face);
    drag.current = { face, mode, sx: e.clientX, sy: e.clientY, fr: frames[face] };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / scale;
    const dy = (e.clientY - d.sy) / scale;
    if (d.mode === "move") patch(d.face, frames ? snap(d.face, d.fr, d.fr.x + dx, d.fr.y + dy, frames, 8 / scale) : { x: d.fr.x + dx, y: d.fr.y + dy });
    else {
      const k = Math.max(0.05, (d.fr.w + dx) / d.fr.w);
      patch(d.face, { w: d.fr.w * k, h: d.fr.h * k });
    }
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!frames) return;
    const step = e.shiftKey ? 5 : 0.5;
    const m: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = m[e.key];
    if (!v) return;
    e.preventDefault();
    patch(sel, { x: frames[sel].x + v[0], y: frames[sel].y + v[1] });
  };

  const resetSizes = () => {
    if (!frames || !dimsOk) return;
    const next = { ...frames };
    for (const f of BOX_FACES) {
      const fr = next[f];
      const [w, h] = onPage(faceSizePt(f, dims), fr.rotate);
      next[f] = { ...fr, x: fr.x + fr.w / 2 - w / 2, y: fr.y + fr.h / 2 - h / 2, w, h };
    }
    setFrames(next);
  };

  const render = async () => {
    if (!doc || !frames) return;
    const faces = BOX_FACES.filter((f) => frames[f].on).map((f) => ({ face: f, page: frames[f].page, x: frames[f].x, y: frames[f].y, w: frames[f].w, h: frames[f].h, rotate: frames[f].rotate }));
    if (!faces.length) {
      setErr("Hãy chọn ít nhất một mặt hộp.");
      return;
    }
    setErr(null);
    setBusy("Đang cắt ảnh từng mặt ở độ nét cao…");
    try {
      setResult((await api.post<{ faces: RenderedFaces }>(`/pdf-imports/${doc.id}/faces`, { faces })).faces);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(null);
    }
  };

  const previewProduct: ProductInfo | null = useMemo(() => {
    if (!result || !dimsOk) return null;
    const k = 0.28 / dims.h;
    const face_urls: ProductInfo["face_urls"] = {};
    for (const f of ["left", "right", "back", "top", "bottom"] as const) if (result[f]) face_urls[f] = result[f]!.url;
    return {
      id: "PDF_PREVIEW",
      sku: "",
      name: "",
      price: null,
      currency: "VND",
      image_url: result.front?.url ?? null,
      face_urls,
      box_color: props.boxColor,
      box_size: { w: dims.w * k, h: 0.28, d: dims.d * k },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, dimsKey, props.boxColor]);

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Lấy các mặt hộp từ file in PDF">
      <div className="modal pdf-picker">
        <div className="row between">
          <h3>Lấy các mặt hộp từ file in PDF</h3>
          <button type="button" onClick={props.onClose} aria-label="Đóng">
            ✕
          </button>
        </div>

        <div className="row wrap">
          <label>
            Kích thước thật (cm): rộng
            <input type="number" min={1} step={0.1} value={cm.w} onChange={(e) => setCm({ ...cm, w: e.target.value })} style={{ width: 80 }} aria-label="Rộng (cm)" />
          </label>
          <label>
            cao
            <input type="number" min={1} step={0.1} value={cm.h} onChange={(e) => setCm({ ...cm, h: e.target.value })} style={{ width: 80 }} aria-label="Cao (cm)" />
          </label>
          <label>
            dày
            <input type="number" min={0.5} step={0.1} value={cm.d} onChange={(e) => setCm({ ...cm, d: e.target.value })} style={{ width: 80 }} aria-label="Dày (cm)" />
          </label>
          <label className="grow">
            File in PDF (≤ 80 MB)
            <input type="file" accept="application/pdf,.pdf" aria-label="File in PDF" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
        </div>
        {!dimsOk && <p className="muted small">Nhập kích thước thật của hộp trước — khung từng mặt sẽ có đúng cỡ đó trên file in.</p>}
        {busy && <p className="muted">{busy}</p>}
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}

        {doc && frames && page && !result && (
          <>
            <p className="muted small">
              Kéo từng khung màu vào đúng mặt trên bản in (phím mũi tên để chỉnh nhích, giữ Shift để nhích nhanh). Kéo góc dưới-phải nếu file in không đúng tỉ lệ thật. Mặt in nằm ngang/ngược thì bấm ⟳ cho đến khi ảnh nhỏ bên phải đứng thẳng.
            </p>
            <div className="picker-body">
              <div className="picker-stage-wrap">
                <div className="row wrap">
                  {doc.pages.length > 1 &&
                    doc.pages.map((p) => (
                      <button type="button" key={p.index} className={p.index === pageIdx ? "primary small" : "small"} onClick={() => setPageIdx(p.index)}>
                        Trang {p.index + 1}
                      </button>
                    ))}
                  <span className="grow" />
                  <label className="row">
                    Phóng to
                    <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Phóng to">
                      <option value={1}>Vừa khung</option>
                      <option value={1.5}>150%</option>
                      <option value={2}>200%</option>
                      <option value={3}>300%</option>
                    </select>
                  </label>
                </div>
                <div className="picker-scroll">
                  <div
                    ref={stageRef}
                    className="picker-stage"
                    style={{ width: page.width_pt * scale, height: page.height_pt * scale }}
                    tabIndex={0}
                    onKeyDown={onKey}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    data-testid="pdf-stage"
                  >
                    <img src={page.preview_url} alt={`Trang ${pageIdx + 1} của file in`} draggable={false} />
                    {BOX_FACES.filter((f) => frames[f].on && frames[f].page === pageIdx).map((f) => {
                      const fr = frames[f];
                      return (
                        <div
                          key={f}
                          className={`pdf-frame${sel === f ? " sel" : ""}`}
                          style={{ left: fr.x * scale, top: fr.y * scale, width: fr.w * scale, height: fr.h * scale, borderColor: FACE_COLOR[f] }}
                          onPointerDown={onDown(f, "move")}
                          data-testid={`frame-${f}`}
                        >
                          <span className="pdf-frame-label" style={{ background: FACE_COLOR[f] }}>
                            {BOX_FACE_LABEL[f]}
                            {fr.rotate ? ` ⟳${fr.rotate}°` : ""}
                          </span>
                          <span className="pdf-frame-size" onPointerDown={onDown(f, "size")} style={{ background: FACE_COLOR[f] }} aria-label={`Đổi cỡ ${BOX_FACE_LABEL[f]}`} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="picker-side">
                {BOX_FACES.map((f) => (
                  <FaceRow
                    key={f}
                    face={f}
                    fr={frames[f]}
                    pages={doc.pages}
                    img={imgs[frames[f].page]}
                    selected={sel === f}
                    onSelect={() => {
                      setSel(f);
                      setPageIdx(frames[f].page);
                    }}
                    onChange={(p) => patch(f, p)}
                    onRotate={() => rotate(f)}
                  />
                ))}
                <button type="button" className="small" onClick={resetSizes}>
                  Đặt lại cỡ khung theo kích thước thật
                </button>
                <button type="button" className="primary" onClick={render} disabled={!!busy}>
                  Cắt ảnh các mặt đã chọn
                </button>
              </div>
            </div>
          </>
        )}

        {result && previewProduct && (
          <div className="picker-body">
            <Suspense fallback={<div className="box-preview muted">Đang mở xem trước 3D…</div>}>
              <BoxPreview3D product={previewProduct} />
            </Suspense>
            <div className="picker-side">
              <p className="small">Hộp trong game sẽ trông như thế này. Mặt nào chưa đúng thì quay lại chỉnh khung.</p>
              <div className="face-results">
                {BOX_FACES.filter((f) => result[f]).map((f) => (
                  <figure key={f}>
                    <img src={result[f]!.url} alt={BOX_FACE_LABEL[f]} />
                    <figcaption>{BOX_FACE_LABEL[f]}</figcaption>
                  </figure>
                ))}
              </div>
              <button type="button" onClick={() => setResult(null)}>
                ← Chỉnh lại khung
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  props.onApply(result);
                  props.onClose();
                }}
              >
                Dùng các mặt này
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
