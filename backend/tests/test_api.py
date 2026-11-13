"""REST API: auth, CSRF, catalog CRUD, live connect validation, shop status."""

import io

from PIL import Image

from tests.conftest import PASSWORD


def test_admin_routes_require_auth(app_client):
    for method, path in [("get", "/api/v1/products"), ("get", "/api/v1/live/status"),
                         ("post", "/api/v1/demo/events"), ("get", "/api/v1/metrics"),
                         ("post", "/api/v1/live/connect")]:
        r = getattr(app_client, method)(path)
        assert r.status_code == 401, path
        assert r.json()["error"]["code"] == "unauthenticated"


def test_health_is_public(app_client):
    r = app_client.get("/api/v1/health")
    assert r.status_code == 200 and r.json()["db"] is True


def test_setup_only_from_loopback(app_client):
    r = app_client.post("/api/v1/auth/setup", json={"username": "x_admin", "password": "a" * 12})
    assert r.status_code == 403  # TestClient peer is not 127.0.0.1


def test_login_lockout_and_csrf(admin_client):
    c = admin_client
    token = c.headers.pop("X-CSRF-Token")
    r = c.post("/api/v1/products", json={"id": "X_1", "sku": "x1", "name": "X"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf"
    c.headers["X-CSRF-Token"] = token
    for _ in range(5):
        assert c.post("/api/v1/auth/login", json={"username": "chu_shop", "password": "sai"}).status_code == 401
    r = c.post("/api/v1/auth/login", json={"username": "chu_shop", "password": PASSWORD})
    assert r.status_code == 429


def test_password_hash_is_argon2id(admin_client):
    from sqlalchemy import select

    from app.models import AdminUser

    with admin_client.app.state.container.db.session() as s:
        h = s.execute(select(AdminUser.password_hash)).scalar_one()
    assert h.startswith("$argon2id$") and PASSWORD not in h


def png_bytes(color=(10, 120, 60)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 60), color).save(buf, format="PNG")
    return buf.getvalue()


def test_product_crud_alias_and_soft_delete(admin_client):
    c = admin_client
    up = c.post("/api/v1/assets/upload", files={"file": ("box.png", png_bytes(), "image/png")}, data={"kind": "image"})
    assert up.status_code == 201, up.text
    body = {"id": "TRA_SEN", "sku": "DEMO-SEN", "name": "Trà sen", "price": 70000, "status": "approved",
            "image_asset_id": up.json()["id"]}
    r = c.post("/api/v1/products", json=body)
    assert r.status_code == 201, r.text
    assert r.json()["price_verified_at"] is None  # price not approved yet
    r = c.post("/api/v1/products/TRA_SEN/aliases", json={"aliases": [{"alias": "sen"}, {"alias": "trà", "is_generic": True}]})
    assert r.status_code == 200 and {a["alias"] for a in r.json()["aliases"]} == {"sen", "trà"}
    # a specific alias owned by another product is refused (no silent wrong pick)
    r = c.post("/api/v1/products/TRA_SEN/aliases", json={"aliases": [{"alias": "cà gai leo"}]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "alias_conflict"
    r = c.patch("/api/v1/products/TRA_SEN", json={"verify_price": True})
    assert r.json()["price_verified_at"] is not None
    r = c.patch("/api/v1/products/TRA_SEN", json={"price": 75000})
    assert r.json()["price_verified_at"] is None  # changed price needs re-approval
    assert c.delete("/api/v1/products/TRA_SEN").json()["soft_deleted"]
    assert c.get("/api/v1/products/TRA_SEN").status_code == 404
    assert "TRA_SEN" not in admin_client.app.state.container.catalog.products


def test_invalid_product_id_message_is_vietnamese(admin_client):
    r = admin_client.post("/api/v1/products", json={"id": "trà xanh", "sku": "a", "name": "b"})
    assert r.status_code == 422 and "Mã sản phẩm" in r.json()["error"]["message"]


def test_bad_uploads_rejected(admin_client):
    c = admin_client
    r = c.post("/api/v1/assets/upload", files={"file": ("x.png", b"<svg onload=alert(1)>", "image/png")}, data={"kind": "image"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_image"
    import json
    import struct
    doc = json.dumps({"asset": {"version": "2.0"}, "buffers": [{"uri": "http://evil.example/x.bin", "byteLength": 1}]}).encode()
    doc += b" " * ((4 - len(doc) % 4) % 4)
    glb = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(doc)) + struct.pack("<II", len(doc), 0x4E4F534A) + doc
    r = c.post("/api/v1/assets/upload", files={"file": ("m.glb", glb, "model/gltf-binary")}, data={"kind": "model"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "external_uri"


def test_move_product_to_new_shelf_publishes_layout(admin_client):
    """T15: after moving the SKU, the catalog (used for new commands) points to the new shelf."""
    c = admin_client
    r = c.patch("/api/v1/shelves/KE_05/slots/S1", json={"product_id": "TRA_CA_GAI_LEO"})
    assert r.status_code == 200
    cat = c.app.state.container.catalog
    assert cat.location_of("TRA_CA_GAI_LEO") == ("KE_05", "S1")
    shelves = {s["code"]: s for s in c.get("/api/v1/shelves").json()}
    assert shelves["KE_02"]["slots"][1]["product_id"] is None


def test_live_connect_validation(admin_client):
    r = admin_client.post("/api/v1/live/connect", json={"url": "https://evil.example/"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_url_host"   # T02
    assert admin_client.get("/api/v1/live/status").json()["status"] == "Chưa kết nối"


def test_live_connect_never_claims_success_before_provider(admin_client):
    """LIVE-02 / T01: the M3 adapter is not implemented, so status must not be 'Đã kết nối'."""
    r = admin_client.post("/api/v1/live/connect", json={"url": "https://www.tiktok.com/@shoptra/live"})
    assert r.status_code == 200
    import time
    for _ in range(50):
        st = admin_client.get("/api/v1/live/status").json()
        if st["status"] != "Đang kiểm tra":
            break
        time.sleep(0.02)
    assert st["status"] == "Không hỗ trợ" and st["status"] != "Đã kết nối"
    assert admin_client.post("/api/v1/live/disconnect").json()["status"] == "Chưa kết nối"


def test_shop_not_configured(admin_client):
    """T19."""
    r = admin_client.get("/api/v1/shop/status").json()
    assert r["status"] == "Not configured" and r["orders_verified"] is False


def test_ai_pause_does_not_stop_game(admin_client):
    """HOST-02 / T16 (no-AI part)."""
    assert admin_client.post("/api/v1/ai/pause", json={"paused": True}).json()["paused"] is True
    r = admin_client.post("/api/v1/demo/events", json={"raw": "@lananh88: trà cà gai leo"})
    assert r.status_code == 200
