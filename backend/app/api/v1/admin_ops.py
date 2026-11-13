"""Backups and configuration export (SYS-03). Restore is CLI-only (server stopped)."""

from __future__ import annotations

import csv
import io
import re
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models import AuditLog, Product, Shelf
from app.security.sessions import AdminDep, CurrentAdmin
from app.services.backup import BackupError, create_backup, list_backups
from app.services.store_layout import rot_deg

router = APIRouter(tags=["admin"])
_BACKUP_NAME = re.compile(r"^chibi-backup-\d{8}-\d{6}(-[a-z0-9-]+)?\.zip$")


def _backup_dir(c):
    return c.settings.data_dir / "backups"


@router.get("/backups")
def backups(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    return {"items": list_backups(_backup_dir(c)),
            "restore_hint": "Tắt server rồi chạy: python scripts/backup_db.py restore <file.zip>",
            "secret_key_note": "File data/secret.key không nằm trong bản sao lưu — hãy cất riêng."}


@router.post("/backups", status_code=201)
def make_backup(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    try:
        path = create_backup(c.settings.resolved_database_url, c.settings.media_dir, _backup_dir(c))
    except BackupError as exc:
        raise HTTPException(422, detail={"code": "backup_failed", "message": str(exc)}) from exc
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="backup_create", resource=path.name))
    return {"name": path.name, "size_bytes": path.stat().st_size, "download": f"/api/v1/backups/{path.name}"}


@router.get("/backups/{name}")
def download_backup(name: str, request: Request, admin: CurrentAdmin = AdminDep):
    c = request.app.state.container
    if not _BACKUP_NAME.match(name):
        raise HTTPException(404, detail={"code": "not_found", "message": "Không tìm thấy bản sao lưu."})
    path = _backup_dir(c) / name
    if not path.is_file():
        raise HTTPException(404, detail={"code": "not_found", "message": "Không tìm thấy bản sao lưu."})
    return FileResponse(path, media_type="application/zip", filename=name)


def _export(c) -> dict:
    with c.db.session() as s:
        products = s.execute(select(Product).options(selectinload(Product.aliases), selectinload(Product.image_asset))
                             .where(Product.deleted_at.is_(None)).order_by(Product.id)).scalars().all()
        shelves = s.execute(select(Shelf).options(selectinload(Shelf.slots)).order_by(Shelf.code)).scalars().all()
        return {
            "format": 1, "exported_at": datetime.now(UTC).isoformat(),
            "products": [{
                "id": p.id, "sku": p.sku, "name": p.name, "price": p.price, "currency": p.currency,
                "price_verified_at": p.price_verified_at.isoformat() if p.price_verified_at else None,
                "status": p.status, "claim_text": p.claim_text, "disclaimer": p.disclaimer,
                "image_sha256": p.image_asset.sha256 if p.image_asset else None, "box_size": p.box_size,
                "aliases": [{"alias": a.alias, "is_generic": a.is_generic} for a in p.aliases],
            } for p in products],
            "shelves": [{
                "code": sh.code, "name": sh.name, "x": sh.transform["x"], "z": sh.transform["z"],
                "rot": rot_deg(sh.transform.get("rot", 0)),
                "slots": {sl.code: sl.product_id for sl in sh.slots},
            } for sh in shelves],
        }


@router.get("/config/export")
def export_config(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Products, aliases and the store map as JSON (no secrets, no images)."""
    return _export(request.app.state.container)


@router.get("/config/products.csv")
def export_products_csv(request: Request, admin: CurrentAdmin = AdminDep) -> Response:
    data = _export(request.app.state.container)
    loc = {pid: f"{sh['code']}/{slot}" for sh in data["shelves"] for slot, pid in sh["slots"].items() if pid}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "sku", "name", "price_vnd", "price_verified", "status", "shelf_slot", "aliases", "generic_aliases"])
    for p in data["products"]:
        w.writerow([p["id"], p["sku"], p["name"], p["price"] if p["price"] is not None else "",
                    "yes" if p["price_verified_at"] else "no", p["status"], loc.get(p["id"], ""),
                    "; ".join(a["alias"] for a in p["aliases"] if not a["is_generic"]),
                    "; ".join(a["alias"] for a in p["aliases"] if a["is_generic"])])
    # BOM so Excel opens Vietnamese text correctly
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="san-pham.csv"'})
