"""Error log for the dashboard ("Nhật ký lỗi") and JavaScript error reports from the pages."""

from __future__ import annotations

from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.models import AuditLog
from app.security.ratelimit import SlidingWindowLimiter
from app.security.sessions import (
    COOKIE_NAME,
    AdminDep,
    CurrentAdmin,
    is_loopback,
    lookup_session,
)

router = APIRouter(tags=["logs"])
_client_limiter = SlidingWindowLimiter(30, 60)


@router.get("/logs")
def list_logs(request: Request, level: str = Query("WARNING", pattern="^(INFO|WARNING|ERROR)$"),
              area: str | None = Query(None, max_length=60), q: str | None = Query(None, max_length=100),
              since_id: int | None = Query(None, ge=0), limit: int = Query(300, ge=1, le=2000),
              admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    items = c.errors.query(level, area, q, since_id, limit)
    areas = sorted({r.area for r in c.errors.records})
    return {"items": [asdict(r) for r in items], "stats": c.errors.stats(c.error_seen_id()), "areas": areas}


class SeenIn(BaseModel):
    id: int = Field(ge=0)


@router.post("/logs/seen")
def mark_seen(body: SeenIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    if body.id > c.error_seen_id():
        c.set_setting("error_log_seen_id", str(body.id), secret=False)
    stats = c.errors.stats(c.error_seen_id())
    c.hub.send_dashboard({"type": "LOG_STATS", "stats": stats})
    return {"stats": stats}


@router.get("/logs/export.txt")
def export_logs(request: Request, admin: CurrentAdmin = AdminDep) -> PlainTextResponse:
    c = request.app.state.container
    return PlainTextResponse("﻿" + c.errors.export_text(), media_type="text/plain; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="nhat-ky-loi.txt"'})


@router.post("/logs/clear")
def clear_logs(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    c.errors.clear()
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="error_log_clear", resource="logs", detail=None))
    stats = c.errors.stats(c.error_seen_id())
    c.hub.send_dashboard({"type": "LOG_STATS", "stats": stats})
    return {"stats": stats}


class ClientErrorIn(BaseModel):
    page: Literal["game", "dashboard"]
    kind: Literal["error", "unhandledrejection", "react", "webgl", "network", "warning"] = "error"
    message: str = Field(min_length=1, max_length=1000)
    stack: str | None = Field(None, max_length=8000)
    url: str | None = Field(None, max_length=300)
    user_agent: str | None = Field(None, max_length=300)


@router.post("/logs/client", status_code=204)
def client_error(body: ClientErrorIn, request: Request) -> None:
    """JavaScript errors of the game page (OBS, no login) and the dashboard. Accepted from this
    computer or from a signed-in admin, at most 30 a minute per address."""
    c = request.app.state.container
    host = request.client.host if request.client else None
    if not is_loopback(host) and lookup_session(c.db, request.cookies.get(COOKIE_NAME)) is None:
        raise HTTPException(403, detail={"code": "forbidden", "message": "Chỉ nhận báo lỗi từ máy này."})
    if not _client_limiter.allow(host or "?"):
        return
    level = "WARNING" if body.kind == "warning" else "ERROR"
    kind = {"error": "Lỗi JavaScript", "unhandledrejection": "Lỗi chưa xử lý (promise)", "react": "Lỗi hiển thị",
            "webgl": "Lỗi đồ họa 3D (WebGL)", "network": "Lỗi kết nối", "warning": "Cảnh báo"}[body.kind]
    c.errors.add(level, f"chibi.client.{body.page}", f"{kind}: {body.message}", body.stack,
                 {"trang": body.url, "trình duyệt": body.user_agent})
    return
