"""Honour board (top gift givers / buyers) and recording purchases."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.models import AuditLog
from app.security.sessions import AdminDep, CurrentAdmin

router = APIRouter(tags=["teahouse"])


class PurchaseIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)  # viewer's TikTok name
    viewer_key: str | None = Field(default=None, max_length=120)
    product_id: str | None = Field(default=None, max_length=64)
    product_name: str | None = Field(default=None, max_length=120)
    qty: int = Field(1, ge=1, le=999)
    amount: int | None = Field(default=None, ge=0, le=1_000_000_000)  # VND; default = price × qty
    thank: bool = True  # the owner thanks the buyer on the LIVE


@router.get("/leaderboard")
def leaderboard(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return request.app.state.container.board.view()


@router.post("/leaderboard/purchase")
def add_purchase(body: PurchaseIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    product = c.catalog.products.get(body.product_id) if body.product_id else None
    if body.product_id and product is None:
        raise HTTPException(404, detail={"code": "not_found", "message": "Không tìm thấy sản phẩm."})
    pname = product.name if product else (body.product_name or "").strip()
    if not pname:
        raise HTTPException(422, detail={"code": "validation", "message": "Chọn sản phẩm hoặc nhập tên sản phẩm."})
    amount = body.amount if body.amount is not None else ((product.display_price or 0) * body.qty if product else 0)
    p = c.board.add_purchase(name=body.name.strip(), key=body.viewer_key, product_id=body.product_id,
                             product_name=pname, qty=body.qty, amount=amount)
    if body.thank:
        c.owner.on_purchase(body.name.strip(), pname, body.qty)
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="purchase_record", resource="leaderboard",
                       detail={"product": pname, "qty": body.qty, "amount": amount}))
    return {"purchase": p, "board": c.board.view()}


@router.delete("/leaderboard/purchase/{pid}")
def delete_purchase(pid: str, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    if not c.board.remove_purchase(pid):
        raise HTTPException(404, detail={"code": "not_found", "message": "Không tìm thấy đơn đã ghi."})
    return c.board.view()


@router.post("/leaderboard/reset")
def reset_board(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    c.board.reset()
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="leaderboard_reset", resource="leaderboard", detail={}))
    return c.board.view()
