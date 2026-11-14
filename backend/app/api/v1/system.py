from __future__ import annotations

from fastapi import APIRouter, Query, Request
from sqlalchemy import select, text

from app.models import ActionJob
from app.models import AuditLog
from app.schemas.api import AiPauseIn, GameSettingsPatch
from app.security.sessions import AdminDep, CurrentAdmin
from app.services.scene_config import THEMES, SceneConfig, save_scene
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


@router.get("/settings/game")
def game_settings(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    return {"idle_exit_minutes": round(c.avatars.idle_exit_seconds / 60, 1),
            "note": "TikTok không gửi sự kiện người xem rời LIVE; Chibi rời cửa hàng khi người xem "
                    "không tương tác trong khoảng thời gian này, hoặc khi số người xem giảm, hoặc khi LIVE kết thúc."}


@router.patch("/settings/game")
def patch_game_settings(body: GameSettingsPatch, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    seconds = int(round(body.idle_exit_minutes * 60))
    c.avatars.idle_exit_seconds = seconds
    c.set_setting("avatar_idle_exit_seconds", str(seconds), secret=False)
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="game_settings_update", resource="avatar_idle_exit_seconds",
                       detail={"seconds": seconds}))
    return game_settings(request, admin)


def _scene_out(c) -> dict:
    return {"config": c.scene.model_dump(), "themes": THEMES}


@router.get("/settings/scene")
def scene_settings(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return _scene_out(request.app.state.container)


@router.put("/settings/scene")
def put_scene_settings(body: SceneConfig, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    body.banner_product_ids = [i for i in dict.fromkeys(body.banner_product_ids) if i in c.catalog.products]
    save_scene(c, body)
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="scene_settings_update", resource="scene_config",
                       detail={"theme": body.theme, "banner": body.banner_enabled,
                               "products": len(body.banner_product_ids)}))
    return _scene_out(c)


@router.get("/shop/status")
def shop(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return shop_status()


@router.get("/ai/suggestions")
def suggestions(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    return {"paused": c.ai_paused, "ai": c.assistant.status(), "speech": c.speech.state(),
            "items": list(c.orchestrator.host_attention)[-50:][::-1]}


@router.post("/ai/pause")
def pause(body: AiPauseIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """HOST-02: pausing AI never stops comment processing or the game."""
    c = request.app.state.container
    c.ai_paused = body.paused
    if body.paused:
        c.speech.kill(mute=False)  # T16: nothing proactive while paused
    c.hub.send_dashboard({"type": "AI_PAUSED", "paused": c.ai_paused})
    return {"paused": c.ai_paused}
