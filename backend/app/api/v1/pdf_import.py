"""Product faces from a print PDF: upload, page previews, render framed faces to images."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.models import AuditLog, MediaAsset
from app.security.sessions import AdminDep, CurrentAdmin
from app.services import pdf_import
from app.services.media import MediaError, store_generated_jpeg

router = APIRouter(tags=["pdf-import"])

FaceName = Literal["front", "back", "left", "right", "top", "bottom"]


class FaceCropIn(BaseModel):
    face: FaceName
    page: int = Field(ge=0)
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    rotate: int = 0


class PdfFacesIn(BaseModel):
    faces: list[FaceCropIn] = Field(min_length=1, max_length=6)

    @field_validator("faces")
    @classmethod
    def _unique(cls, v: list[FaceCropIn]) -> list[FaceCropIn]:
        names = [f.face for f in v]
        if len(set(names)) != len(names):
            raise ValueError("mỗi mặt hộp chỉ được chọn một lần")
        return v


def _err(exc: MediaError) -> HTTPException:
    status = 404 if exc.code in ("import_gone", "bad_import", "bad_page") else 422
    return HTTPException(status, detail={"code": exc.code, "message": exc.message})


def _out(import_id: str, pages: list[pdf_import.PdfPageInfo]) -> dict:
    return {"id": import_id, "pages": [
        {"index": p.index, "width_pt": p.width_pt, "height_pt": p.height_pt,
         "preview_url": f"/api/v1/pdf-imports/{import_id}/pages/{p.index}.png"} for p in pages]}


@router.post("/pdf-imports", status_code=201)
async def upload_pdf(request: Request, file: UploadFile = File(...), admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    data = await file.read(pdf_import.MAX_PDF_BYTES + 1)
    try:
        import_id, pages = await run_in_threadpool(pdf_import.import_pdf, c.settings.data_dir, data)
    except MediaError as exc:
        raise _err(exc) from exc
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="pdf_import", resource=import_id,
                       detail={"pages": len(pages), "bytes": len(data)}))
    return _out(import_id, pages)


@router.get("/pdf-imports/{import_id}")
def get_pdf(import_id: str, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    try:
        return _out(import_id, pdf_import.page_info(c.settings.data_dir, import_id))
    except MediaError as exc:
        raise _err(exc) from exc


@router.get("/pdf-imports/{import_id}/pages/{index}.png")
def page_preview(import_id: str, index: int, request: Request, admin: CurrentAdmin = AdminDep) -> FileResponse:
    c = request.app.state.container
    try:
        path = pdf_import.render_preview(c.settings.data_dir, import_id, index)
    except MediaError as exc:
        raise _err(exc) from exc
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/pdf-imports/{import_id}/faces")
def render_faces(import_id: str, body: PdfFacesIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Render each framed face and store it as an image asset. The product is not changed here:
    the editor puts the returned asset ids into the product form and the owner saves it."""
    c = request.app.state.container
    out: dict[str, dict] = {}
    try:
        stored = []
        for f in body.faces:
            img = pdf_import.render_face(c.settings.data_dir, import_id, f.page, f.x, f.y, f.w, f.h, f.rotate)
            stored.append((f.face, store_generated_jpeg(c.settings.media_dir, pdf_import.encode_face(img)), img.size))
    except MediaError as exc:
        raise _err(exc) from exc
    with c.db.session() as s:
        for face, st, size in stored:
            row = s.execute(select(MediaAsset).where(MediaAsset.sha256 == st.sha256)).scalar_one_or_none()
            if row is None:
                row = MediaAsset(kind=st.kind, file_path=st.rel_path, sha256=st.sha256, mime=st.mime,
                                 size_bytes=st.size_bytes)
                s.add(row)
                s.flush()
            out[face] = {"id": row.id, "url": f"/media/{row.file_path}", "width": size[0], "height": size[1]}
        s.add(AuditLog(admin_id=admin.id, action="pdf_faces", resource=import_id, detail={"faces": sorted(out)}))
    return {"faces": out}
