from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import select

from app.models import AuditLog, LiveEventRow
from app.providers.demo_adapter import DemoProvider
from app.providers.tiktoklive_adapter import TikTokLiveAdapter
from app.providers.url_validator import InvalidLiveUrl, parse_live_url, resolve_short_link
from app.schemas.api import BenchmarkIn, ConnectIn, DemoEventIn, LiveSettingsPatch
from app.security.crypto import mask_secret
from app.security.sessions import AdminDep, CurrentAdmin

router = APIRouter(tags=["live"])


@router.post("/live/connect")
async def connect(body: ConnectIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    try:
        parsed = parse_live_url(body.url)
        if parsed.needs_resolution:
            parsed = await resolve_short_link(parsed.url)
    except InvalidLiveUrl as exc:
        raise HTTPException(422, detail={"code": f"invalid_url_{exc.code}", "message": exc.message}) from exc
    if not body.policy_ack:
        raise HTTPException(422, detail={"code": "policy_ack_required", "message":
                            "Hãy xác nhận danh sách kiểm tra chính sách Shop LIVE trước khi kết nối."})
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="live_connect", resource=parsed.url))
    adapter = TikTokLiveAdapter(parsed.unique_id, sign_api_key=c.get_setting("tiktok_sign_api_key"),
                                client_factory=c.tiktok_client_factory)
    await c.live.start(adapter, url=parsed.url, unique_id=parsed.unique_id)
    return c.live.status_dict()


@router.get("/settings/live")
def live_settings(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    try:
        import TikTokLive  # noqa: F401
        installed = True
    except ImportError:
        installed = False
    return {"sign_api_key": mask_secret(c.get_setting("tiktok_sign_api_key")), "library_installed": installed,
            "library": "TikTokLive 7.0.1 (không chính thức)", "sign_server": "api.eulerstream.com"}


@router.patch("/settings/live")
def patch_live_settings(body: LiveSettingsPatch, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Optional Euler Stream key for higher signing limits. Stored encrypted, never returned."""
    c = request.app.state.container
    c.set_setting("tiktok_sign_api_key", (body.sign_api_key or "").strip() or None, secret=True)
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="live_settings_update", resource="tiktok_sign_api_key"))
    return live_settings(request, admin)


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


# ---------------------------------------------------------------------- performance (T16)
@router.get("/game/perf")
def game_perf(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    v = c.perf.view()
    v["visible"] = len(c.avatars.visible())
    v["max_visible"] = c.avatars.max_visible
    v["waiting"] = len(c.avatars.overflow)
    v["is_demo"] = c.live.is_demo
    v["live_real"] = c.live.provider is not None and not c.live.is_demo
    return v


def _demo_only(request: Request) -> None:
    _require_demo(request)
    c = request.app.state.container
    if c.live.provider is not None and not c.live.is_demo:
        raise HTTPException(409, detail={"code": "live_active", "message":
                            "Chỉ đo thử khi chạy Demo — đang có phiên LIVE thật."})


@router.post("/game/benchmark")
async def game_benchmark(body: BenchmarkIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Fill the shop with demo Chibis up to `count` and measure the OBS page for 20 seconds."""
    _demo_only(request)
    c = request.app.state.container
    if not c.hub.has_primary():
        raise HTTPException(409, detail={"code": "no_game_page", "message":
                            "Chưa mở màn hình game (/game/live) — mở nó trên máy phát LIVE rồi đo lại."})
    if not c.live.is_demo:
        await c.live.start(DemoProvider())
    provider: DemoProvider = c.live.provider  # type: ignore[assignment]
    target = min(body.count, c.avatars.max_visible)
    missing = max(0, target - len(c.avatars.visible()))
    if missing:
        await provider.inject({"type": "SPAWN_RANDOM", "count": missing})
    c.perf.start(target)
    return {"target": target, "added": missing, "max_visible": c.avatars.max_visible}


@router.post("/game/benchmark/clear")
def game_benchmark_clear(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Demo only: every Chibi waves goodbye and leaves (to measure again from an empty shop)."""
    _demo_only(request)
    c = request.app.state.container
    gone = c.avatars.exit_all("benchmark_clear")
    for avatar_id in gone:
        c.actions.cancel_avatar(avatar_id, "benchmark_clear")
        c.camera.forget_avatar(avatar_id)
    return {"left": len(gone)}
