"""Server-side sessions: random token in an HttpOnly cookie, only its SHA-256 stored.
State-changing requests must also send the per-session CSRF token in X-CSRF-Token."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request, WebSocket
from sqlalchemy import delete, select

from app.models import AdminSession, AdminUser

COOKIE_NAME = "chibi_session"
CSRF_HEADER = "X-CSRF-Token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db, admin_id: int, ttl_minutes: int) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    now = datetime.now(UTC)
    with db.session() as s:
        s.execute(delete(AdminSession).where(AdminSession.expires_at < now))
        s.add(AdminSession(token_hash=_hash(token), admin_id=admin_id, csrf_token=csrf,
                           expires_at=now + timedelta(minutes=ttl_minutes)))
    return token, csrf


def destroy_session(db, token: str | None) -> None:
    if not token:
        return
    with db.session() as s:
        s.execute(delete(AdminSession).where(AdminSession.token_hash == _hash(token)))


def lookup_session(db, token: str | None) -> tuple[AdminUser, AdminSession] | None:
    if not token:
        return None
    with db.session() as s:
        row = s.execute(
            select(AdminSession, AdminUser)
            .join(AdminUser, AdminUser.id == AdminSession.admin_id)
            .where(AdminSession.token_hash == _hash(token))
        ).first()
        if not row:
            return None
        sess, user = row
        expires = sess.expires_at if sess.expires_at.tzinfo else sess.expires_at.replace(tzinfo=UTC)
        if expires < datetime.now(UTC):
            return None
        return user, sess


class CurrentAdmin:
    def __init__(self, user: AdminUser, csrf_token: str):
        self.id = user.id
        self.username = user.username
        self.role = user.role
        self.csrf_token = csrf_token


def require_admin(request: Request) -> CurrentAdmin:
    db = request.app.state.container.db
    found = lookup_session(db, request.cookies.get(COOKIE_NAME))
    if not found:
        raise HTTPException(401, detail={"code": "unauthenticated", "message": "Vui lòng đăng nhập."})
    user, sess = found
    if request.method not in SAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not hmac.compare_digest(sent, sess.csrf_token):
            raise HTTPException(403, detail={"code": "csrf", "message": "Thiếu hoặc sai mã CSRF."})
    return CurrentAdmin(user, sess.csrf_token)


AdminDep = Depends(require_admin)


def websocket_admin(ws: WebSocket) -> CurrentAdmin | None:
    db = ws.app.state.container.db
    found = lookup_session(db, ws.cookies.get(COOKIE_NAME))
    if not found:
        return None
    user, sess = found
    return CurrentAdmin(user, sess.csrf_token)


LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def is_loopback(host: str | None) -> bool:
    return bool(host) and host in LOOPBACK
