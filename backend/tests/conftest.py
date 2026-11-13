from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.seed import seed_demo
from app.services.catalog import build_catalog

BACKEND = Path(__file__).resolve().parent.parent
PASSWORD = "mat-khau-thu-nghiem"


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


def migrate(url: str) -> None:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "head")


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist",
                    command_cooldown_seconds=0.0, demo_rate_per_minute=10_000)


@pytest.fixture
def db(settings: Settings) -> Database:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    migrate(settings.resolved_database_url)
    database = Database(settings.resolved_database_url)
    seed_demo(database, settings.media_dir)
    return database


@pytest.fixture
def catalog(db):
    return build_catalog(db, 1)


@pytest.fixture
def app_client(settings, db):
    from app.main import create_app

    app = create_app(settings)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def admin_client(app_client):
    r = app_client.post("/api/v1/auth/setup", json={"username": "chu_shop", "password": PASSWORD},
                        headers={"X-Forwarded-For": "127.0.0.1"})
    # TestClient's peer host is "testclient", so create the admin directly instead.
    if r.status_code == 403:
        from app.models import AdminUser
        from app.security.passwords import hash_password

        c = app_client.app.state.container
        with c.db.session() as s:
            s.add(AdminUser(username="chu_shop", password_hash=hash_password(PASSWORD), role="owner"))
        r = app_client.post("/api/v1/auth/login", json={"username": "chu_shop", "password": PASSWORD})
    assert r.status_code in (200, 201), r.text
    app_client.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return app_client
