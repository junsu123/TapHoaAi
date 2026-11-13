"""Backup / restore (SYS-03).

A backup is one .zip: a consistent SQLite snapshot (sqlite3 backup API, safe while the
server runs), every media file, and manifest.json. The encryption key (secret.key) is NOT
included — keep it separately; on a machine with a different key, stored secrets must be
re-entered (the game token is regenerated automatically).

Restore replaces the database and adds media files. It is done from the command line
with the server stopped (scripts/backup_db.py restore …), after an automatic safety backup."""

from __future__ import annotations

import json
import re
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path

FORMAT = 1
MANIFEST = "manifest.json"
DB_NAME = "chibi.db"
_MEDIA_NAME = re.compile(r"^media/[0-9a-f]{2}/[0-9a-f]{64}\.(png|glb)$")
MAX_TOTAL_BYTES = 2 * 1024**3


class BackupError(ValueError):
    pass


def sqlite_path(database_url: str) -> Path:
    if not database_url.startswith("sqlite:///"):
        raise BackupError("Sao lưu tự động chỉ hỗ trợ SQLite.")
    return Path(database_url.removeprefix("sqlite:///"))


def _snapshot(db_file: Path, dest: Path) -> None:
    src = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def _counts(db_file: Path) -> dict[str, int]:
    con = sqlite3.connect(db_file)
    try:
        out = {}
        for table in ("products", "shelves", "media_assets", "admin_users"):
            out[table] = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608 - fixed names
        rev = con.execute("SELECT version_num FROM alembic_version").fetchone()
        out_rev = rev[0] if rev else None
    finally:
        con.close()
    return {**out, "alembic_revision": out_rev}  # type: ignore[dict-item]


def create_backup(database_url: str, media_dir: Path, out_dir: Path, label: str = "") -> Path:
    db_file = sqlite_path(database_url)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    suffix = f"-{re.sub(r'[^a-z0-9-]', '', label.lower())}" if label else ""
    target = out_dir / f"chibi-backup-{stamp}{suffix}.zip"
    with tempfile.TemporaryDirectory() as tmp:
        snap = Path(tmp) / DB_NAME
        _snapshot(db_file, snap)
        counts = _counts(snap)
        media = sorted(p for p in media_dir.rglob("*") if p.is_file() and _MEDIA_NAME.match(f"media/{p.relative_to(media_dir).as_posix()}"))
        manifest = {
            "format": FORMAT, "created_at": datetime.now(UTC).isoformat(), "app": "chibi-live-shop",
            "counts": {k: v for k, v in counts.items() if k != "alembic_revision"},
            "alembic_revision": counts["alembic_revision"], "media_files": len(media),
            "includes_secret_key": False,
        }
        tmp_zip = target.with_suffix(".zip.part")
        with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2))
            z.write(snap, DB_NAME)
            for p in media:
                z.write(p, f"media/{p.relative_to(media_dir).as_posix()}")
        tmp_zip.replace(target)
    return target


def inspect_backup(path: Path) -> dict:
    """Validate a backup without extracting it: names allow-listed (no path traversal),
    sizes bounded, SQLite header present."""
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise BackupError("File không phải bản sao lưu hợp lệ (.zip).") from exc
    with z:
        names = z.namelist()
        if MANIFEST not in names or DB_NAME not in names:
            raise BackupError("Bản sao lưu thiếu manifest.json hoặc chibi.db.")
        total = 0
        for info in z.infolist():
            if info.filename not in (MANIFEST, DB_NAME) and not _MEDIA_NAME.match(info.filename):
                raise BackupError(f"Tên file lạ trong bản sao lưu: {info.filename!r}")
            total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise BackupError("Bản sao lưu quá lớn.")
        try:
            manifest = json.loads(z.read(MANIFEST))
        except json.JSONDecodeError as exc:
            raise BackupError("manifest.json bị lỗi.") from exc
        if manifest.get("format") != FORMAT:
            raise BackupError("Định dạng bản sao lưu không được hỗ trợ.")
        if z.read(DB_NAME)[:16] != b"SQLite format 3\x00":
            raise BackupError("chibi.db trong bản sao lưu không phải SQLite.")
    return manifest


def restore_backup(path: Path, database_url: str, media_dir: Path, safety_dir: Path) -> dict:
    """Replace the database and add media from `path`. Call only with the server stopped."""
    manifest = inspect_backup(path)
    db_file = sqlite_path(database_url)
    safety = None
    if db_file.exists():
        safety = create_backup(database_url, media_dir, safety_dir, label="truoc-khi-khoi-phuc")
    media_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as z, tempfile.TemporaryDirectory() as tmp:
        tmp_db = Path(tmp) / DB_NAME
        with z.open(DB_NAME) as src, open(tmp_db, "wb") as dst:
            shutil.copyfileobj(src, dst)
        for name in z.namelist():
            if _MEDIA_NAME.match(name):
                target = media_dir / name.removeprefix("media/")
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    with z.open(name) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
        for extra in (db_file.with_name(db_file.name + "-wal"), db_file.with_name(db_file.name + "-shm")):
            extra.unlink(missing_ok=True)
        db_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(tmp_db, db_file)
    return {"restored": manifest, "safety_backup": str(safety) if safety else None}


def list_backups(out_dir: Path) -> list[dict]:
    if not out_dir.exists():
        return []
    return [{"name": p.name, "size_bytes": p.stat().st_size,
             "created_at": datetime.fromtimestamp(p.stat().st_mtime, UTC).isoformat()}
            for p in sorted(out_dir.glob("chibi-backup-*.zip"), reverse=True)]
