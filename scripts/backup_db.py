"""Back up / restore the database and product media.

    python scripts/backup_db.py backup              # → data/backups/chibi-backup-<time>.zip
    python scripts/backup_db.py list
    python scripts/backup_db.py restore FILE.zip    # server must be STOPPED

Restore first makes a safety backup of the current data, then replaces the database and
adds media files, then applies migrations (an older backup is upgraded automatically).
secret.key is never inside a backup: keep a copy of data/secret.key somewhere safe.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.services.backup import BackupError, create_backup, list_backups, restore_backup  # noqa: E402


def server_running(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("backup")
    sub.add_parser("list")
    r = sub.add_parser("restore")
    r.add_argument("file", type=Path)
    r.add_argument("--force", action="store_true", help="restore even if a server seems to be running")
    args = ap.parse_args()

    s = get_settings()
    out_dir = s.data_dir / "backups"
    try:
        if args.cmd == "backup":
            path = create_backup(s.resolved_database_url, s.media_dir, out_dir)
            print(f"Đã sao lưu: {path}")
            print("Nhớ cất riêng file", s.data_dir / "secret.key")
        elif args.cmd == "list":
            for b in list_backups(out_dir):
                print(f"{b['name']}  {b['size_bytes'] / 1024:.0f} KB  {b['created_at']}")
        else:
            if server_running(s.host, s.port) and not args.force:
                sys.exit(f"Server đang chạy ở cổng {s.port}. Hãy tắt server trước khi khôi phục (hoặc dùng --force).")
            result = restore_backup(args.file.resolve(), s.resolved_database_url, s.media_dir, out_dir)
            cfg = Config(str(BACKEND / "alembic.ini"))
            cfg.set_main_option("script_location", str(BACKEND / "alembic"))
            cfg.set_main_option("sqlalchemy.url", s.resolved_database_url)
            command.upgrade(cfg, "head")
            print("Đã khôi phục:", result["restored"]["created_at"], result["restored"]["counts"])
            if result["safety_backup"]:
                print("Bản sao lưu an toàn của dữ liệu cũ:", result["safety_backup"])
    except BackupError as exc:
        sys.exit(f"Lỗi: {exc}")


if __name__ == "__main__":
    main()
