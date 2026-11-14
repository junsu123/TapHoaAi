"""Products, aliases, assets and shelves (PRD-01..04, GAME-02)."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models import AuditLog, MediaAsset, Product, ProductAlias, Shelf, ShelfSlot
from app.schemas.api import AliasesIn, ProductIn, ProductOut, ProductPatch, ShelfIn, ShelfPatch, SlotPatch
from app.security.sessions import AdminDep, CurrentAdmin
from app.services.action_queue import TERMINAL
from app.services.catalog import face_urls
from app.services.media import MediaError, store_glb, store_image
from app.services.store_layout import SHELF_D, SLOT_XS, rot_deg, shelf_geometry, validate_layout
from app.text_norm import normalize_vi

router = APIRouter(tags=["catalog"])


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _product_out(p: Product, c, s) -> ProductOut:
    loc = c.catalog.location_of(p.id)
    return ProductOut(
        id=p.id, sku=p.sku, name=p.name, price=p.price, currency=p.currency,
        price_verified_at=p.price_verified_at, status=p.status, claim_text=p.claim_text,
        disclaimer=p.disclaimer, image_url=f"/media/{p.image_asset.file_path}" if p.image_asset else None,
        model_url=f"/media/{p.model_asset.file_path}" if p.model_asset else None,
        face_urls=face_urls(s, p.face_assets), box_color=p.box_color,
        card_image_url=f"/media/{p.card_image_asset.file_path}" if p.card_image_asset else None,
        box_size=p.box_size,
        aliases=[{"id": a.id, "alias": a.alias, "is_generic": a.is_generic, "priority": a.priority} for a in p.aliases],
        location={"shelf_id": loc[0], "slot_id": loc[1]} if loc else None, updated_at=p.updated_at,
    )


def _load(s, product_id: str) -> Product:
    p = s.execute(select(Product).options(selectinload(Product.aliases), selectinload(Product.image_asset),
                                          selectinload(Product.model_asset), selectinload(Product.card_image_asset))
                  .where(Product.id == product_id, Product.deleted_at.is_(None))).scalar_one_or_none()
    if p is None:
        raise _err(404, "not_found", "Không tìm thấy sản phẩm.")
    return p


def _check_assets(s, image_asset_id: int | None, model_asset_id: int | None) -> None:
    """An image slot must reference an uploaded image, a model slot an uploaded GLB."""
    for asset_id, kind, label in ((image_asset_id, "image", "ảnh"), (model_asset_id, "model", "mô hình GLB")):
        if asset_id is None:
            continue
        a = s.get(MediaAsset, asset_id)
        if a is None or a.kind != kind:
            raise _err(422, "bad_asset", f"File {label} không hợp lệ — hãy tải lên lại.")


def _check_image_ids(s, ids: list[int | None]) -> None:
    for asset_id in ids:
        if asset_id is None:
            continue
        a = s.get(MediaAsset, asset_id)
        if a is None or a.kind != "image":
            raise _err(422, "bad_asset", "File ảnh không hợp lệ — hãy tải lên lại.")


def _check_alias_conflicts(s, product_id: str, normalized: str, is_generic: bool) -> None:
    """Refuse an alias that already points to another product, unless both are generic
    (generic aliases are always treated as ambiguous by the matcher)."""
    rows = s.execute(select(ProductAlias).join(Product).where(
        ProductAlias.alias_normalized == normalized, ProductAlias.product_id != product_id,
        Product.deleted_at.is_(None))).scalars().all()
    for r in rows:
        if not (r.is_generic and is_generic):
            raise _err(409, "alias_conflict",
                       f"Từ khóa '{r.alias}' đã dùng cho sản phẩm {r.product_id}. "
                       "Đánh dấu 'từ chung' cho cả hai nếu muốn coi là mơ hồ.")


@router.get("/products")
def list_products(request: Request, admin: CurrentAdmin = AdminDep) -> list[ProductOut]:
    c = request.app.state.container
    with c.db.session() as s:
        rows = s.execute(select(Product).options(selectinload(Product.aliases), selectinload(Product.image_asset),
                                                 selectinload(Product.model_asset), selectinload(Product.card_image_asset))
                         .where(Product.deleted_at.is_(None)).order_by(Product.name)).scalars().all()
        return [_product_out(p, c, s) for p in rows]


@router.post("/products", status_code=201)
def create_product(body: ProductIn, request: Request, admin: CurrentAdmin = AdminDep) -> ProductOut:
    c = request.app.state.container
    with c.db.session() as s:
        if s.get(Product, body.id) is not None:
            raise _err(409, "exists", "Mã sản phẩm đã tồn tại.")
        if s.execute(select(Product).where(Product.sku == body.sku)).scalar_one_or_none():
            raise _err(409, "sku_exists", "SKU đã tồn tại.")
        data = body.model_dump(exclude={"verify_price"})
        _check_assets(s, body.image_asset_id, body.model_asset_id)
        _check_image_ids(s, [body.card_image_asset_id, *(body.face_assets or {}).values()])
        p = Product(**data)
        if body.verify_price and body.price is not None:
            p.price_verified_at = datetime.now(UTC)
        s.add(p)
        s.add(AuditLog(admin_id=admin.id, action="product_create", resource=body.id, detail={"price": body.price}))
    c.reload_catalog()
    with c.db.session() as s:
        return _product_out(_load(s, body.id), c, s)


@router.get("/products/{product_id}")
def get_product(product_id: str, request: Request, admin: CurrentAdmin = AdminDep) -> ProductOut:
    c = request.app.state.container
    with c.db.session() as s:
        return _product_out(_load(s, product_id), c, s)


@router.patch("/products/{product_id}")
def patch_product(product_id: str, body: ProductPatch, request: Request, admin: CurrentAdmin = AdminDep) -> ProductOut:
    c = request.app.state.container
    changes = body.model_dump(exclude_unset=True, exclude={"verify_price"})
    with c.db.session() as s:
        p = _load(s, product_id)
        _check_assets(s, changes.get("image_asset_id"), changes.get("model_asset_id"))
        _check_image_ids(s, [changes.get("card_image_asset_id"), *(changes.get("face_assets") or {}).values()])
        if "face_assets" in changes and changes["face_assets"] is not None:
            # merge: {"left": 12} sets the left face, {"left": null} removes it
            merged = dict(p.face_assets or {})
            for face, aid in changes["face_assets"].items():
                if aid is None:
                    merged.pop(face, None)
                else:
                    merged[face] = aid
            changes["face_assets"] = merged or None
        price_changed = "price" in changes and changes["price"] != p.price
        for k, v in changes.items():
            setattr(p, k, v)
        if price_changed:
            p.price_verified_at = None  # SPEC H2: a new price must be re-approved
        if body.verify_price and p.price is not None:
            p.price_verified_at = datetime.now(UTC)
        s.add(AuditLog(admin_id=admin.id, action="product_update", resource=product_id,
                       detail={k: v for k, v in changes.items() if k in ("price", "status", "claim_text")}))
    c.reload_catalog()
    with c.db.session() as s:
        return _product_out(_load(s, product_id), c, s)


@router.delete("/products/{product_id}")
def delete_product(product_id: str, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    with c.db.session() as s:
        p = _load(s, product_id)
        p.deleted_at = datetime.now(UTC)
        p.status = "disabled"
        for slot in s.execute(select(ShelfSlot).where(ShelfSlot.product_id == product_id)).scalars():
            slot.product_id = None
        s.add(AuditLog(admin_id=admin.id, action="product_delete", resource=product_id))
    c.reload_catalog()
    return {"ok": True, "soft_deleted": True}


@router.post("/products/{product_id}/aliases")
def set_aliases(product_id: str, body: AliasesIn, request: Request, admin: CurrentAdmin = AdminDep) -> ProductOut:
    c = request.app.state.container
    with c.db.session() as s:
        p = _load(s, product_id)
        if body.replace:
            p.aliases.clear()
            s.flush()
        existing = {a.alias_normalized for a in p.aliases}
        for a in body.aliases:
            norm = normalize_vi(a.alias)
            if not norm:
                raise _err(422, "empty_alias", f"Từ khóa '{a.alias}' rỗng sau khi chuẩn hóa.")
            _check_alias_conflicts(s, product_id, norm, a.is_generic)
            if norm in existing:
                continue
            existing.add(norm)
            p.aliases.append(ProductAlias(alias=a.alias, alias_normalized=norm, is_generic=a.is_generic,
                                          priority=a.priority))
        s.add(AuditLog(admin_id=admin.id, action="aliases_update", resource=product_id))
    c.reload_catalog()
    with c.db.session() as s:
        return _product_out(_load(s, product_id), c, s)


@router.post("/assets/upload", status_code=201)
async def upload_asset(request: Request, file: UploadFile = File(...), kind: str = Form("image"),
                       admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    data = await file.read(21 * 1024 * 1024)
    try:
        stored = store_image(c.settings.media_dir, data) if kind == "image" else (
            store_glb(c.settings.media_dir, data) if kind == "model" else None)
    except MediaError as exc:
        raise _err(422, exc.code, exc.message) from exc
    if stored is None:
        raise _err(422, "bad_kind", "kind phải là image hoặc model.")
    with c.db.session() as s:
        row = s.execute(select(MediaAsset).where(MediaAsset.sha256 == stored.sha256)).scalar_one_or_none()
        if row is None:
            row = MediaAsset(kind=stored.kind, file_path=stored.rel_path, sha256=stored.sha256,
                             mime=stored.mime, size_bytes=stored.size_bytes)
            s.add(row)
            s.flush()
        return {"id": row.id, "url": f"/media/{row.file_path}", "kind": row.kind, "size_bytes": row.size_bytes}


def _shelf_out(sh: Shelf) -> dict:
    return {"code": sh.code, "name": sh.name, "transform": sh.transform, "rot": rot_deg(sh.transform.get("rot", 0)),
            "stand_positions": sh.stand_positions, "wait_positions": sh.wait_positions,
            "slots": [{"code": sl.code, "product_id": sl.product_id, "is_active": sl.is_active,
                       "slot_transform": sl.slot_transform} for sl in sh.slots]}


def _all_shelves(s) -> list[Shelf]:
    return list(s.execute(select(Shelf).options(selectinload(Shelf.slots)).order_by(Shelf.code)).scalars())


def _validate_or_422(candidate: list[dict]) -> None:
    errors = validate_layout(candidate)
    if errors:
        raise HTTPException(422, detail={"code": "layout_invalid", "message": " ".join(errors), "errors": errors})


def _busy_shelf(c, code: str) -> bool:
    return any(cmd.shelf_code == code and cmd.status not in TERMINAL for cmd in c.actions.commands.values())


@router.get("/shelves")
def list_shelves(request: Request, admin: CurrentAdmin = AdminDep) -> list[dict]:
    c = request.app.state.container
    with c.db.session() as s:
        return [_shelf_out(sh) for sh in _all_shelves(s)]


@router.get("/store/layout")
def store_layout(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Everything the 2D editor draws: store size, counter, door zone, shelves."""
    from app.services import store_layout as sl

    c = request.app.state.container
    with c.db.session() as s:
        shelves = [_shelf_out(sh) for sh in _all_shelves(s)]
    return {"store": {"width": sl.STORE_W, "depth": sl.STORE_D}, "counter": sl.COUNTER, "door": sl.DOOR,
            "door_zone": list(sl.DOOR_ZONE), "min_gap": sl.MIN_GAP, "shelves": shelves}


@router.post("/shelves", status_code=201)
def create_shelf(body: ShelfIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    geo = shelf_geometry(body.x, body.z, body.rot)
    with c.db.session() as s:
        existing = _all_shelves(s)
        if any(sh.code == body.code for sh in existing):
            raise _err(409, "exists", "Mã kệ đã tồn tại.")
        candidate = [{"code": sh.code, "name": sh.name, "transform": sh.transform,
                      "stand_positions": sh.stand_positions, "wait_positions": sh.wait_positions} for sh in existing]
        candidate.append({"code": body.code, "name": body.name, **geo})
        _validate_or_422(candidate)
        sh = Shelf(code=body.code, name=body.name, transform=geo["transform"], waypoints=[],
                   stand_positions=geo["stand_positions"], wait_positions=geo["wait_positions"])
        for i, dx in enumerate(SLOT_XS, start=1):
            sh.slots.append(ShelfSlot(code=f"S{i}", slot_transform={"x": dx, "y": 0.55, "z": SHELF_D / 2 - 0.12}))
        s.add(sh)
        s.add(AuditLog(admin_id=admin.id, action="shelf_create", resource=body.code, detail=body.model_dump()))
    c.reload_catalog()
    with c.db.session() as s:
        return _shelf_out(next(x for x in _all_shelves(s) if x.code == body.code))


@router.patch("/shelves/{shelf_code}")
def patch_shelf(shelf_code: str, body: ShelfPatch, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Move / rotate / rename. Refused while a Chibi is using this shelf."""
    c = request.app.state.container
    if (body.x is not None or body.z is not None or body.rot is not None) and _busy_shelf(c, shelf_code):
        raise _err(409, "shelf_busy", "Đang có khách lấy hàng ở kệ này — thử lại sau vài giây.")
    with c.db.session() as s:
        shelves = _all_shelves(s)
        target = next((x for x in shelves if x.code == shelf_code), None)
        if target is None:
            raise _err(404, "not_found", "Không tìm thấy kệ.")
        t = target.transform
        x = body.x if body.x is not None else t["x"]
        z = body.z if body.z is not None else t["z"]
        rot = body.rot if body.rot is not None else rot_deg(t.get("rot", 0))
        geo = shelf_geometry(x, z, rot, t.get("w", 2.4), t.get("d", 0.6))
        name = body.name or target.name
        candidate = [{"code": sh.code, "name": sh.name, "transform": sh.transform,
                      "stand_positions": sh.stand_positions, "wait_positions": sh.wait_positions}
                     for sh in shelves if sh.code != shelf_code]
        candidate.append({"code": shelf_code, "name": name, **geo})
        _validate_or_422(candidate)
        target.name = name
        target.transform = geo["transform"]
        target.stand_positions = geo["stand_positions"]
        target.wait_positions = geo["wait_positions"]
        s.add(AuditLog(admin_id=admin.id, action="shelf_update", resource=shelf_code,
                       detail=body.model_dump(exclude_none=True)))
    c.reload_catalog()
    with c.db.session() as s:
        return _shelf_out(next(x for x in _all_shelves(s) if x.code == shelf_code))


@router.delete("/shelves/{shelf_code}")
def delete_shelf(shelf_code: str, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    if _busy_shelf(c, shelf_code):
        raise _err(409, "shelf_busy", "Đang có khách lấy hàng ở kệ này — thử lại sau vài giây.")
    with c.db.session() as s:
        sh = s.execute(select(Shelf).where(Shelf.code == shelf_code)).scalar_one_or_none()
        if sh is None:
            raise _err(404, "not_found", "Không tìm thấy kệ.")
        freed = [sl.product_id for sl in sh.slots if sl.product_id]
        s.delete(sh)
        s.add(AuditLog(admin_id=admin.id, action="shelf_delete", resource=shelf_code, detail={"freed": freed}))
    c.reload_catalog()
    return {"ok": True, "unshelved_products": freed}


@router.patch("/shelves/{shelf_code}/slots/{slot_code}")
def patch_slot(shelf_code: str, slot_code: str, body: SlotPatch, request: Request,
               admin: CurrentAdmin = AdminDep) -> dict:
    """Map a product to a slot. A product lives in at most one slot (T15: moving it is
    'publish' — the next comment walks to the new shelf)."""
    c = request.app.state.container
    with c.db.session() as s:
        slot = s.execute(select(ShelfSlot).join(Shelf).where(Shelf.code == shelf_code, ShelfSlot.code == slot_code)
                         ).scalar_one_or_none()
        if slot is None:
            raise _err(404, "not_found", "Không tìm thấy kệ/slot.")
        if body.product_id is not None:
            p = s.get(Product, body.product_id)
            if p is None or p.deleted_at is not None:
                raise _err(404, "product_not_found", "Không tìm thấy sản phẩm.")
            for other in s.execute(select(ShelfSlot).where(ShelfSlot.product_id == body.product_id)).scalars():
                other.product_id = None
        slot.product_id = body.product_id
        s.add(AuditLog(admin_id=admin.id, action="slot_update", resource=f"{shelf_code}/{slot_code}",
                       detail={"product_id": body.product_id}))
    c.reload_catalog()
    return {"ok": True, "layout_version": c.catalog.version}
