from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import select

from app.models import AuditLog, LiveEventRow
from app.providers.demo_adapter import DemoProvider
from app.providers.tiktoklive_adapter import TikTokLiveAdapter
from app.providers.url_validator import InvalidLiveUrl, parse_live_url
from app.schemas.api import ConnectIn, DemoEventIn
from app.security.sessions import AdminDep, CurrentAdmin

router = APIRouter(tags=["live"])


@router.post("/live/connect")
async def connect(body: ConnectIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    try:
        parsed = parse_live_url(body.url)
    except InvalidLiveUrl as exc:
        raise HTTPException(422, detail={"code": f"invalid_url_{exc.code}", "message": exc.message}) from exc
    if parsed.needs_resolution:
        raise HTTPException(422, detail={"code": "short_link", "message":
                            "Link rút gọn (vm.tiktok.com) sẽ được hỗ trợ ở M3. Hãy dán link dạng https://www.tiktok.com/@tên/live"})
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="live_connect", resource=parsed.url))
    await c.live.start(TikTokLiveAdapter(parsed.unique_id), url=parsed.url, unique_id=parsed.unique_id)
    return c.live.status_dict()


@router.post("/live/disconnect")
async def disconnect(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    await c.live.stop()
    return c.live.status_dict()


@router.get("/live/status")
def status(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    return {**c.live.status_dict(), "demo_enabled": c.settings.demo_enabled,
            "shop_integration": "Not configured"}


@router.get("/live/events")
def events(request: Request, admin: CurrentAdmin = AdminDep, limit: int = Query(50, ge=1, le=500),
           before_id: int | None = None, session_id: str | None = None) -> dict:
    c = request.app.state.container
    sid = session_id or c.live.session_id
    with c.db.session() as s:
        q = select(LiveEventRow).order_by(LiveEventRow.id.desc()).limit(limit)
        if sid:
            q = q.where(LiveEventRow.session_id == sid)
        if before_id:
            q = q.where(LiveEventRow.id < before_id)
        rows = s.execute(q).scalars().all()
        items = [{"id": r.id, "event_id": r.source_event_id, "provider": r.provider, "type": r.type,
                  "dedup_mode": r.dedup_mode, "payload": r.safe_payload, "observed_at": r.observed_at.isoformat()}
                 for r in rows]
    return {"items": items, "next_before_id": items[-1]["id"] if len(items) == limit else None}


# ---------------------------------------------------------------- demo (LIVE-07)
def _require_demo(request: Request) -> None:
    if not request.app.state.container.settings.demo_enabled:
        raise HTTPException(403, detail={"code": "demo_disabled", "message": "Chế độ Demo đang tắt."})


@router.post("/demo/start")
async def demo_start(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    _require_demo(request)
    c = request.app.state.container
    if not c.live.is_demo:
        await c.live.start(DemoProvider())
    return c.live.status_dict()


@router.post("/demo/events")
async def demo_events(body: DemoEventIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    _require_demo(request)
    c = request.app.state.container
    if not request.app.state.demo_limiter.allow(str(admin.id)):
        raise HTTPException(429, detail={"code": "rate_limited", "message": "Gửi sự kiện demo quá nhanh."})
    if c.live.provider is not None and not c.live.is_demo:
        raise HTTPException(409, detail={"code": "live_active", "message":
                            "Đang có phiên LIVE thật. Ngắt kết nối trước khi dùng Demo."})
    if not c.live.is_demo:
        await c.live.start(DemoProvider())
    provider: DemoProvider = c.live.provider  # type: ignore[assignment]
    try:
        ids = await provider.inject(body.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(422, detail={"code": "bad_demo_event", "message": str(exc)}) from exc
    return {"event_ids": ids, "session_id": c.live.session_id}
