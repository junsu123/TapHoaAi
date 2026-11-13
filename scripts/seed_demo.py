"""Apply migrations, seed the demo store and (optionally) create the first operator.

Usage (from the repo root):
    python scripts/seed_demo.py
    python scripts/seed_demo.py --admin chu_shop --password "mat-khau-du-dai"
Without --admin, create the operator on first visit to http://127.0.0.1:8000/dashboard.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import Database  # noqa: E402
from app.models import AdminUser  # noqa: E402
from app.security.passwords import hash_password  # noqa: E402
from app.seed import seed_demo  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin")
    ap.add_argument("--password")
    args = ap.parse_args()

    settings = get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    cfg.set_main_option("sqlalchemy.url", settings.resolved_database_url)
    command.upgrade(cfg, "head")

    db = Database(settings.resolved_database_url)
    print("seeded:", seed_demo(db, settings.media_dir))
    if args.admin:
        if not args.password:
            sys.exit("--password is required with --admin")
        with db.session() as s:
            if s.execute(select(AdminUser).where(AdminUser.username == args.admin)).scalar_one_or_none():
                print("admin exists:", args.admin)
            else:
                s.add(AdminUser(username=args.admin, password_hash=hash_password(args.password), role="owner"))
                print("created admin:", args.admin)


if __name__ == "__main__":
    main()
