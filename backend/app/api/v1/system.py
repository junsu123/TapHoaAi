from __future__ import annotations

from fastapi import APIRouter, Query, Request
from sqlalchemy import select, text

from app.models import ActionJob
from app.schemas.api import AiPauseIn
from app.security.sessions import AdminDep, CurrentAdmin
from app.services.shop_integration import shop_status

router = APIRouter(tags=["system"])


@router.get("/health")
def health(request: Request) -> dict:
    c = request.app.state.container
    db_ok = True
    try:
        with c.db.session() as s:
            s.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        db_ok = False
    return {"status": "ok" if db_ok else "degraded", "db": db_ok, "live": c.live.status.value,
            "game_primary_connected": c.hub.has_primary()}


@router.get("/metrics")
def metrics(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return request.app.state.container.metrics()


@router.get("/actions")
def actions(request: Request, admin: CurrentAdmin = AdminDep, limit: int = Query(50, ge=1, le=500)) -> list[dict]:
    c = request.app.state.container
    with c.db.session() as s:
        rows = s.execute(select(ActionJob).order_by(ActionJob.id.desc()).limit(limit)).scalars().all()
        return [{"command_id": r.command_id, "avatar_id": r.avatar_id, "product_id": r.product_id,
                 "shelf_id": r.shelf_code, "status": r.status, "reason": r.reason,
                 "created_at": r.created_at.isoformat()} for r in rows]


@router.get("/game/info")
def game_info(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    return {"game_url": "/game/live", "remote_token": c.game_token,
            "note": "Mở trên chính máy này không cần token. Máy khác: thêm ?token=… vào URL."}


@router.get("/shop/status")
def shop(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return shop_status()


@router.get("/ai/suggestions")
def suggestions(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    return {"paused": c.ai_paused, "ai_configured": False,
            "items": list(c.orchestrator.host_attention)[-50:][::-1]}


@router.post("/ai/pause")
def pause(body: AiPauseIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """HOST-02: pausing AI never stops comment processing or the game."""
    c = request.app.state.container
    c.ai_paused = body.paused
    c.hub.send_dashboard({"type": "AI_PAUSED", "paused": c.ai_paused})
    return {"paused": c.ai_paused}
