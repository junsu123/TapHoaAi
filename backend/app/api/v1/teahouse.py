"""Honour board (top gift givers / buyers) and recording purchases."""

from __future__ import annotations

from typing import Literal

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


# ---------------------------------------------------------------------- dance stage
class StageRemoveIn(BaseModel):
    key: str = Field(min_length=1, max_length=200)


@router.get("/stage")
def stage(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return request.app.state.container.stage.view()


@router.post("/stage/skip")
def stage_skip(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    c.stage.skip()
    c.stage.tick()
    return c.stage.view()


@router.post("/stage/remove")
def stage_remove(body: StageRemoveIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    if not c.stage.remove(body.key):
        raise HTTPException(404, detail={"code": "not_in_line", "message": "Người này không còn trong hàng chờ."})
    c.stage.tick()
    return c.stage.view()


@router.post("/stage/clear")
def stage_clear(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    c.stage.clear()
    c.stage.tick()
    return c.stage.view()


# ---------------------------------------------------------------------- owner: poem / story now
class TalkIn(BaseModel):
    kind: str = Field(pattern="^(poem|story)$")


@router.get("/talk")
def talk(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return request.app.state.container.talk.view()


@router.post("/talk/now")
async def talk_now(body: TalkIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """The host asks the owner for a poem / a story right now (for everyone watching)."""
    c = request.app.state.container
    if not c.assistant.voice_ready()[0]:
        raise HTTPException(409, detail={"code": "voice_off", "message": "Bật “Phát trên LIVE” trước (Trợ lý AI & giọng đọc)."})
    c.talk._last_any = -1e9  # the host decides: no waiting
    out = c.talk.request(body.kind, None, None)
    what = "bài thơ" if body.kind == "poem" else "câu chuyện"
    msg = f"Chủ quán sắp đọc {what} trên LIVE." if out.endswith("_queued") else "Đang tắt Làm thơ, kể chuyện." if out.endswith("_off") else "Chưa đọc được, thử lại sau ít giây."
    return {"outcome": out, "message": msg}


@router.get("/levels")
def levels(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Chibi levels: who has stayed longest this LIVE, recent level-ups."""
    return request.app.state.container.levels.view()


class LevelTry(BaseModel):
    name: str | None = Field(None, max_length=80)


@router.post("/levels/try")
def levels_try(body: LevelTry, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Demo only: a Chibi on screen goes up one level now (to see the hat, cape and crown)."""
    c = request.app.state.container
    if not c.live.is_demo:
        raise HTTPException(409, "Chỉ thử được khi đang chạy Demo.")
    r = c.levels.try_next(body.name)
    if r is None:
        raise HTTPException(409, "Không có Chibi nào trên màn hình để lên cấp (hoặc tất cả đã có vương miện).")
    return {"ok": True, "message": f"{r['name']} sắp được {r['next']}.", **r}


GameKind = Literal["price", "quiz", "keyword"]


class GameStart(BaseModel):
    kind: GameKind | None = None


@router.get("/games")
def games(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Mini-games: the round on now, the next one, recent winners."""
    return request.app.state.container.games.dashboard_view()


@router.post("/games/start")
def games_start(body: GameStart, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    if not c.live.session_id:
        raise HTTPException(409, "Chưa có LIVE (hoặc Demo) đang chạy.")
    if c.games.round is not None:
        raise HTTPException(409, "Đang có một mini-game, chờ xong đã.")
    if body.kind == "price" and not c.games._priced():
        raise HTTPException(409, "Chưa có sản phẩm nào có giá đã kiểm tra để đoán giá.")
    r = c.games.start(body.kind, manual=True)
    if r is None:
        raise HTTPException(409, "Chưa bắt đầu được mini-game.")
    return {"ok": True, "kind": r.kind, "title": r.data and c.games.view()["title"]}


@router.post("/games/stop")
def games_stop(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return {"ok": request.app.state.container.games.stop()}
