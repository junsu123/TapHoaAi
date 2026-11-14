"""FastAPI app. Start with `python -m app` (uses CHIBI_PORT, default 8686)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1 import admin_ops, auth, catalog, live, pdf_import, system
from app.config import Settings, get_settings
from app.container import AppContainer
from app.security.ratelimit import LoginLockout, SlidingWindowLimiter
from app.websocket import routes as ws_routes

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app(settings: Settings | None = None, container: AppContainer | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        c = container or AppContainer(settings)
        app.state.container = c
        await c.start()
        try:
            yield
        finally:
            await c.stop()

    app = FastAPI(title="Chibi AI TikTok Live Shop", version="0.1.0", lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.login_lockout = LoginLockout(settings.login_max_failures, settings.login_lock_minutes * 60)
    app.state.demo_limiter = SlidingWindowLimiter(settings.demo_rate_per_minute, 60)

    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                       allow_methods=["GET", "POST", "PATCH", "DELETE"],
                       allow_headers=["Content-Type", "X-CSRF-Token"])

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if not request.url.path.startswith("/game"):
            response.headers.setdefault("X-Frame-Options", "DENY")
        return response

    @app.exception_handler(HTTPException)
    async def http_error(_req: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        return JSONResponse({"error": detail}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_req: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        msg = str(first.get("msg", "Dữ liệu không hợp lệ")).removeprefix("Value error, ")
        return JSONResponse({"error": {"code": "validation", "message": msg,
                                       "field": ".".join(str(x) for x in first.get("loc", []))}},
                            status_code=422)

    for r in (auth.router, live.router, catalog.router, pdf_import.router, system.router, admin_ops.router):
        app.include_router(r, prefix="/api/v1")
    app.include_router(ws_routes.router)

    settings.media_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=settings.media_dir), name="media")

    dist = settings.frontend_dist
    if (dist / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="spa-assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str):
            if full_path.startswith(("api/", "ws/", "media/")):
                return JSONResponse({"error": {"code": "not_found", "message": "Not found"}}, status_code=404)
            candidate = (dist / full_path).resolve()
            if full_path and candidate.is_file() and dist.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")

    return app


app = create_app()
