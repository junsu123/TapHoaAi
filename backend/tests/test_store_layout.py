"""Shelf editor: geometry, validation and API (GAME-02, PRD-02, T15)."""

import pytest

from app.seed import SHELVES
from app.services.store_layout import shelf_geometry, validate_layout


def seed_shelves():
    return [{"code": c, "name": n, **shelf_geometry(x, z)} for c, n, x, z in SHELVES]


def test_seed_layout_is_valid():
    assert validate_layout(seed_shelves()) == []


@pytest.mark.parametrize("rot,front", [(0, (0, 1)), (90, (1, 0)), (180, (0, -1)), (270, (-1, 0))])
def test_stand_positions_are_in_front_for_every_rotation(rot, front):
    g = shelf_geometry(0.0, 0.0, rot)
    for p in g["stand_positions"]:
        # 0.85 m in front of the centre, along the front direction
        assert round(p["x"] * front[0] + p["z"] * front[1], 3) == 0.85


@pytest.mark.parametrize("x,z,rot,needle", [
    (0.0, 7.0, 0, "chắn lối cửa"),
    (3.0, -2.6, 0, "quá sát"),
    (5.9, 0.0, 0, "ngoài cửa hàng"),
    (0.0, -5.6, 0, "quầy thu ngân"),
])
def test_invalid_positions_are_explained(x, z, rot, needle):
    layout = seed_shelves() + [{"code": "KE_07", "name": "Kệ 7", **shelf_geometry(x, z, rot)}]
    errors = validate_layout(layout)
    assert errors and any(needle in e for e in errors), errors


def test_unreachable_stand_positions_are_refused():
    # a wall of shelves cutting the store in half leaves the back shelves unreachable
    wall = [{"code": f"W{i}", "name": f"Tường {i}", **shelf_geometry(x, -5.0, 0)} for i, x in enumerate((-4.2, -1.4, 1.4, 4.2))]
    errors = validate_layout(wall + [{"code": "BACK", "name": "Kệ sau", **shelf_geometry(-3.0, -7.0, 180)}])
    assert any("không đi từ cửa" in e or "quá sát" in e or "bị chắn" in e for e in errors)


# ---------------------------------------------------------------- API
def test_create_rotated_shelf_and_map_product(admin_client):
    c = admin_client
    r = c.post("/api/v1/shelves", json={"code": "KE_07", "name": "Kệ 7", "x": 0, "z": 0, "rot": 90})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["rot"] == 90 and len(body["slots"]) == 3
    assert all(p["x"] == 0.85 for p in body["stand_positions"])
    assert c.patch("/api/v1/shelves/KE_07/slots/S1", json={"product_id": "TRA_BA_KICH"}).status_code == 200
    layout = c.app.state.container.catalog.layout_dict()
    ke7 = next(s for s in layout["shelves"] if s["code"] == "KE_07")
    assert ke7["slots"][0]["product_id"] == "TRA_BA_KICH"
    assert c.app.state.container.catalog.location_of("TRA_BA_KICH") == ("KE_07", "S1")


def test_invalid_create_returns_vietnamese_reasons(admin_client):
    r = admin_client.post("/api/v1/shelves", json={"code": "KE_07", "name": "Kệ 7", "x": 0, "z": 7, "rot": 0})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "layout_invalid" and "chắn lối cửa" in err["message"]
    assert len(admin_client.get("/api/v1/shelves").json()) == 6


def test_move_rotate_and_reject_overlap(admin_client):
    c = admin_client
    r = c.patch("/api/v1/shelves/KE_05", json={"x": -3.5, "z": 4.0})
    assert r.status_code == 200 and r.json()["transform"]["x"] == -3.5
    r = c.patch("/api/v1/shelves/KE_05", json={"rot": 180})
    assert r.status_code == 200 and r.json()["rot"] == 180
    r = c.patch("/api/v1/shelves/KE_05", json={"x": 3.0, "z": 3.5})  # on top of KE_06
    assert r.status_code == 422
    assert c.get("/api/v1/store/layout").json()["shelves"][4]["transform"]["x"] == -3.5  # unchanged


def test_cannot_move_a_shelf_a_chibi_is_using(admin_client):
    c = admin_client
    c.post("/api/v1/demo/events", json={"raw": "@lananh88: trà cà gai leo"})
    import time
    for _ in range(50):
        if any(cmd.shelf_code == "KE_02" for cmd in c.app.state.container.actions.commands.values()):
            break
        time.sleep(0.02)
    r = c.patch("/api/v1/shelves/KE_02", json={"x": 3.5})
    assert r.status_code == 409 and r.json()["error"]["code"] == "shelf_busy"
    assert c.patch("/api/v1/shelves/KE_02", json={"name": "Kệ trà"}).status_code == 200  # renaming is fine


def test_delete_shelf_unshelves_products(admin_client):
    c = admin_client
    r = c.delete("/api/v1/shelves/KE_03")
    assert r.status_code == 200 and r.json()["unshelved_products"] == ["TRA_BA_KICH"]
    assert c.app.state.container.catalog.location_of("TRA_BA_KICH") is None
    p = c.get("/api/v1/products/TRA_BA_KICH").json()
    assert p["location"] is None
