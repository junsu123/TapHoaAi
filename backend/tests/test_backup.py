"""Backup / restore / export (SYS-03)."""

import io
import json
import sqlite3
import zipfile

import pytest

from app.services.backup import BackupError, create_backup, inspect_backup, restore_backup


def test_backup_roundtrip_restores_data_and_media(settings, db, tmp_path):
    url = settings.resolved_database_url
    media = settings.media_dir
    media_files = sorted(p.relative_to(media) for p in media.rglob("*.png"))
    assert media_files  # seeded product photos
    zpath = create_backup(url, media, tmp_path / "bk")
    manifest = inspect_backup(zpath)
    assert manifest["counts"]["products"] == 2 and manifest["counts"]["shelves"] == 6
    assert manifest["media_files"] == len(media_files) and manifest["includes_secret_key"] is False

    # damage the live data, then restore
    db_file = settings.data_dir / "chibi.db"
    con = sqlite3.connect(db_file)
    con.execute("DELETE FROM product_aliases")
    con.execute("DELETE FROM shelf_slots")
    con.execute("DELETE FROM shelves")
    con.commit()
    con.close()
    for f in media.rglob("*.png"):
        f.unlink()
    db.engine.dispose()  # restore runs with the server stopped: no open connections
    result = restore_backup(zpath, url, media, tmp_path / "bk")
    assert result["safety_backup"] and "truoc-khi-khoi-phuc" in result["safety_backup"]
    con = sqlite3.connect(db_file)
    assert con.execute("SELECT COUNT(*) FROM shelves").fetchone()[0] == 6
    con.close()
    assert sorted(p.relative_to(media) for p in media.rglob("*.png")) == media_files


def _zip(entries: dict[str, bytes]) -> io.BytesIO:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for k, v in entries.items():
            z.writestr(k, v)
    buf.seek(0)
    return buf


@pytest.mark.parametrize("entries,needle", [
    ({"manifest.json": b'{"format":1}'}, "thiếu"),
    ({"manifest.json": b'{"format":1}', "chibi.db": b"SQLite format 3\x00", "../../evil.py": b"x"}, "lạ"),
    ({"manifest.json": b'{"format":1}', "chibi.db": b"SQLite format 3\x00", "media/ab/../../x.png": b"x"}, "lạ"),
    ({"manifest.json": b'{"format":9}', "chibi.db": b"SQLite format 3\x00"}, "không được hỗ trợ"),
    ({"manifest.json": b'{"format":1}', "chibi.db": b"not sqlite"}, "không phải SQLite"),
])
def test_malicious_or_broken_backups_rejected(tmp_path, entries, needle):
    p = tmp_path / "x.zip"
    p.write_bytes(_zip(entries).getvalue())
    with pytest.raises(BackupError) as e:
        inspect_backup(p)
    assert needle in str(e.value)


def test_backup_api_and_exports(admin_client):
    c = admin_client
    r = c.post("/api/v1/backups")
    assert r.status_code == 201, r.text
    name = r.json()["name"]
    assert [b["name"] for b in c.get("/api/v1/backups").json()["items"]] == [name]
    dl = c.get(f"/api/v1/backups/{name}")
    assert dl.status_code == 200 and dl.content[:2] == b"PK"
    assert c.get("/api/v1/backups/..%2Fchibi.db").status_code == 404
    cfg = c.get("/api/v1/config/export").json()
    assert {p["id"] for p in cfg["products"]} == {"TRA_CA_GAI_LEO", "TRA_BA_KICH"}
    assert next(s for s in cfg["shelves"] if s["code"] == "KE_02")["slots"]["S2"] == "TRA_CA_GAI_LEO"
    assert "api_key" not in json.dumps(cfg).lower() and "password" not in json.dumps(cfg).lower()
    csv_text = c.get("/api/v1/config/products.csv").content.decode("utf-8-sig")
    assert "Trà cà gai leo" in csv_text and "KE_02/S2" in csv_text


def test_backup_requires_auth(app_client):
    assert app_client.post("/api/v1/backups").status_code == 401
    assert app_client.get("/api/v1/config/export").status_code == 401


def test_restored_db_with_other_secret_key_regenerates_game_token(settings, db, monkeypatch):
    from app.container import AppContainer

    first = AppContainer(settings, db=db).game_token
    (settings.data_dir / "secret.key").unlink()  # simulate a different machine
    second = AppContainer(settings, db=db).game_token
    assert first and second and first != second
