"""Import product faces from the shop's print file (PDF).

A print file is usually the box "dieline": one page with the unfolded box, every face at real
size. Some printers send one page per face instead. Either way the shop owner places a frame
over each face in the dashboard; this module renders the pages for preview and renders each
framed area at texture resolution.

The PDF is kept in <data_dir>/pdf_imports (never under /media, which the game page serves
publicly): print files are the shop's design property. Imports older than KEEP_DAYS are removed.
Rendering uses PDFium (pypdfium2, BSD-3/Apache-2.0), which is not thread-safe: all calls hold
one lock."""

from __future__ import annotations

import hashlib
import io
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

from app.services.media import MediaError

MAX_PDF_BYTES = 80 * 1024 * 1024
MAX_PAGES = 30
MAX_PAGE_PT = 72 * 300 / 2.54  # 3 m — anything larger is not a box print file
PREVIEW_MAX_SIDE = 1600
FACE_MAX_SIDE = 1536
FACE_MAX_DPI = 600
MIN_FACE_PT = 14  # 5 mm
KEEP_DAYS = 7
ROTATIONS = (0, 90, 180, 270)

_lock = threading.Lock()
_ID_RE = re.compile(r"^[0-9a-f]{24}$")


@dataclass
class PdfPageInfo:
    index: int
    width_pt: float
    height_pt: float


def imports_dir(data_dir: Path) -> Path:
    d = data_dir / "pdf_imports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _pdf_path(data_dir: Path, import_id: str) -> Path:
    if not _ID_RE.match(import_id):
        raise MediaError("bad_import", "Mã file PDF không hợp lệ.")
    p = imports_dir(data_dir) / f"{import_id}.pdf"
    if not p.exists():
        raise MediaError("import_gone", "File PDF đã hết hạn hoặc chưa tải lên — hãy tải lại.")
    return p


def _open(path: Path | bytes) -> pdfium.PdfDocument:
    try:
        return pdfium.PdfDocument(path)
    except pdfium.PdfiumError as exc:
        msg = str(exc).lower()
        if "password" in msg:
            raise MediaError("pdf_password", "PDF có mật khẩu — hãy xuất lại file không đặt mật khẩu.") from exc
        raise MediaError("bad_pdf", "File không phải PDF hợp lệ.") from exc


def _pages(doc: pdfium.PdfDocument) -> list[PdfPageInfo]:
    n = len(doc)
    if n == 0:
        raise MediaError("bad_pdf", "PDF không có trang nào.")
    if n > MAX_PAGES:
        raise MediaError("too_many_pages", f"PDF có {n} trang — tối đa {MAX_PAGES} trang.")
    out = []
    for i in range(n):
        page = doc[i]
        w, h = page.get_size()  # in the page's displayed orientation (/Rotate applied)
        page.close()
        if not (MIN_FACE_PT <= w <= MAX_PAGE_PT and MIN_FACE_PT <= h <= MAX_PAGE_PT):
            raise MediaError("bad_page_size", f"Trang {i + 1} có kích thước bất thường.")
        out.append(PdfPageInfo(i, round(w, 2), round(h, 2)))
    return out


def cleanup(data_dir: Path, now: float | None = None) -> None:
    cutoff = (now or time.time()) - KEEP_DAYS * 86400
    for p in imports_dir(data_dir).iterdir():
        if p.stat().st_mtime < cutoff:
            p.unlink(missing_ok=True)


def import_pdf(data_dir: Path, data: bytes) -> tuple[str, list[PdfPageInfo]]:
    if len(data) > MAX_PDF_BYTES:
        raise MediaError("too_large", "File PDF vượt quá 80 MB.")
    if b"%PDF-" not in data[:1024]:
        raise MediaError("bad_pdf", "File không phải PDF hợp lệ.")
    import_id = hashlib.sha256(data).hexdigest()[:24]
    with _lock:
        doc = _open(data)
        try:
            pages = _pages(doc)
        finally:
            doc.close()
        cleanup(data_dir)
        path = imports_dir(data_dir) / f"{import_id}.pdf"
        if not path.exists():
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        else:
            path.touch()
    return import_id, pages


def page_info(data_dir: Path, import_id: str) -> list[PdfPageInfo]:
    with _lock:
        doc = _open(_pdf_path(data_dir, import_id))
        try:
            return _pages(doc)
        finally:
            doc.close()


def _render(doc: pdfium.PdfDocument, index: int, scale: float, crop_pt: tuple[float, float, float, float] | None) -> Image.Image:
    """crop_pt = (x, y, w, h) in points, origin top-left of the displayed page."""
    page = doc[index]
    try:
        pw, ph = page.get_size()
        crop = (0, 0, 0, 0)
        if crop_pt:
            x, y, w, h = crop_pt
            crop = (x, ph - (y + h), pw - (x + w), y)  # amounts cut from left, bottom, right, top
        bitmap = page.render(scale=scale, crop=crop, may_draw_forms=False)
        img = bitmap.to_pil().convert("RGB")
        bitmap.close()
        return img
    finally:
        page.close()


def render_preview(data_dir: Path, import_id: str, index: int) -> Path:
    path = _pdf_path(data_dir, import_id)
    out = imports_dir(data_dir) / f"{import_id}.p{index}.png"
    if out.exists():
        return out
    with _lock:
        doc = _open(path)
        try:
            if not 0 <= index < len(doc):
                raise MediaError("bad_page", "Trang không tồn tại.")
            pw, ph = doc[index].get_size()
            img = _render(doc, index, PREVIEW_MAX_SIDE / max(pw, ph), None)
        finally:
            doc.close()
    tmp = out.with_suffix(".tmp")
    img.save(tmp, format="PNG", optimize=True)
    tmp.replace(out)
    return out


def render_face(data_dir: Path, import_id: str, index: int, x: float, y: float, w: float, h: float,
                rotate: int) -> Image.Image:
    if rotate not in ROTATIONS:
        raise MediaError("bad_rotate", "Góc xoay chỉ được 0, 90, 180 hoặc 270.")
    if w < MIN_FACE_PT or h < MIN_FACE_PT:
        raise MediaError("face_too_small", "Khung mặt hộp quá nhỏ (dưới 5 mm).")
    path = _pdf_path(data_dir, import_id)
    with _lock:
        doc = _open(path)
        try:
            if not 0 <= index < len(doc):
                raise MediaError("bad_page", "Trang không tồn tại.")
            pw, ph = doc[index].get_size()
            # clamp the frame to the page; a frame entirely outside is a mistake
            x0, y0 = max(0.0, x), max(0.0, y)
            x1, y1 = min(pw, x + w), min(ph, y + h)
            if x1 - x0 < MIN_FACE_PT or y1 - y0 < MIN_FACE_PT:
                raise MediaError("face_outside", "Khung mặt hộp nằm ngoài trang PDF.")
            scale = min(FACE_MAX_SIDE / max(x1 - x0, y1 - y0), FACE_MAX_DPI / 72)
            img = _render(doc, index, scale, (x0, y0, x1 - x0, y1 - y0))
        finally:
            doc.close()
    if rotate:
        img = img.rotate(-rotate, expand=True)  # PIL rotates counter-clockwise; ours is clockwise
    return img


def encode_face(img: Image.Image) -> bytes:
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue()
