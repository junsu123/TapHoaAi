from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import func, select

from app.models import AdminUser, AuditLog
from app.schemas.api import LoginIn, MeOut, SetupIn
from app.security.passwords import hash_password, verify_password
from app.security.sessions import (
    COOKIE_NAME, AdminDep, CurrentAdmin, create_session, destroy_session, is_loopback,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_cookie(request: Request, response: Response, token: str) -> None:
    s = request.app.state.container.settings
    response.set_cookie(COOKIE_NAME, token, httponly=True, samesite="strict", secure=s.cookie_secure,
                        max_age=s.session_ttl_minutes * 60, path="/")


@router.get("/setup")
def setup_needed(request: Request) -> dict:
    db = request.app.state.container.db
    with db.session() as s:
        n = s.execute(select(func.count(AdminUser.id))).scalar_one()
    return {"setup_required": n == 0}


@router.post("/setup", status_code=201)
def setup(body: SetupIn, request: Request, response: Response) -> MeOut:
    """Create the first operator. Only allowed when no admin exists AND from this PC."""
    c = request.app.state.container
    if not is_loopback(request.client.host if request.client else None):
        raise HTTPException(403, detail={"code": "not_local", "message": "Chỉ tạo tài khoản đầu tiên trên chính máy chạy phần mềm."})
    with c.db.session() as s:
        if s.execute(select(func.count(AdminUser.id))).scalar_one() > 0:
            raise HTTPException(409, detail={"code": "exists", "message": "Đã có tài khoản quản trị."})
        try:
            user = AdminUser(username=body.username, password_hash=hash_password(body.password), role="owner")
        except ValueError as exc:
            raise HTTPException(422, detail={"code": "weak_password", "message": str(exc)}) from exc
        s.add(user)
        s.flush()
        s.add(AuditLog(admin_id=user.id, action="setup", resource="admin_users"))
        uid, uname, role = user.id, user.username, user.role
    token, csrf = create_session(c.db, uid, c.settings.session_ttl_minutes)
    _set_cookie(request, response, token)
    return MeOut(username=uname, role=role, csrf_token=csrf)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response) -> MeOut:
    c = request.app.state.container
    ip = request.client.host if request.client else "?"
    key = f"{ip}|{body.username.lower()}"
    lockout = request.app.state.login_lockout
    if lockout.is_locked(key):
        raise HTTPException(429, detail={"code": "locked", "message": "Sai mật khẩu quá nhiều lần. Thử lại sau 15 phút."})
    with c.db.session() as s:
        user = s.execute(select(AdminUser).where(AdminUser.username == body.username)).scalar_one_or_none()
        ok = user is not None and verify_password(user.password_hash, body.password)
        if not ok:
            lockout.record_failure(key)
            raise HTTPException(401, detail={"code": "bad_credentials", "message": "Sai tên đăng nhập hoặc mật khẩu."})
        uid, uname, role = user.id, user.username, user.role
        s.add(AuditLog(admin_id=uid, action="login", resource="session"))
    lockout.reset(key)
    token, csrf = create_session(c.db, uid, c.settings.session_ttl_minutes)
    _set_cookie(request, response, token)
    return MeOut(username=uname, role=role, csrf_token=csrf)


@router.post("/logout")
def logout(request: Request, response: Response, admin: CurrentAdmin = AdminDep) -> dict:
    destroy_session(request.app.state.container.db, request.cookies.get(COOKIE_NAME))
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(admin: CurrentAdmin = AdminDep) -> MeOut:
    return MeOut(username=admin.username, role=admin.role, csrf_token=admin.csrf_token)
