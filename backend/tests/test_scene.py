"""Shop look (herbal-tea theme) and the on-stream product banner settings."""

from __future__ import annotations

from .test_pipeline import game_ws, recv_until


def test_scene_defaults_to_herbal_tea_shop_and_is_in_the_snapshot(admin_client):
    r = admin_client.get("/api/v1/settings/scene")
    assert r.status_code == 200
    cfg = r.json()["config"]
    assert cfg["theme"] == "herbal"
    assert cfg["sign_text"] == "TIỆM TRÀ THẢO MỘC"
    assert cfg["banner_enabled"] is True
    assert "herbal" in r.json()["themes"]
    with game_ws(admin_client) as ws:
        snap = ws.receive_json()
        assert snap["type"] == "SNAPSHOT"
        assert snap["scene"]["theme"] == "herbal"


def test_saving_scene_pushes_to_the_game_and_persists(admin_client):
    c = admin_client.app.state.container
    pid = next(iter(c.catalog.products))
    with game_ws(admin_client) as ws:
        ws.receive_json()
        body = {**c.scene.model_dump(), "sign_text": "  TRÀ   MỘC TÂM ", "banner_seconds": 8,
                "banner_product_ids": [pid, pid, "khong-ton-tai"], "theme": "kawaii"}
        r = admin_client.put("/api/v1/settings/scene", json=body)
        assert r.status_code == 200, r.text
        out = r.json()["config"]
        assert out["sign_text"] == "TRÀ MỘC TÂM"
        assert out["banner_product_ids"] == [pid]
        msg, _ = recv_until(ws, lambda m: m.get("type") == "SCENE_UPDATED")
        assert msg["scene"]["theme"] == "kawaii"
        assert msg["scene"]["banner_seconds"] == 8
    from app.services.scene_config import load_scene

    assert load_scene(c).sign_text == "TRÀ MỘC TÂM"


def test_scene_validation(admin_client):
    c = admin_client.app.state.container
    base = c.scene.model_dump()
    assert admin_client.put("/api/v1/settings/scene", json={**base, "theme": "neon"}).status_code == 422
    assert admin_client.put("/api/v1/settings/scene", json={**base, "banner_seconds": 1}).status_code == 422
    assert admin_client.put("/api/v1/settings/scene", json={**base, "sign_text": "x" * 60}).status_code == 422


def test_board_can_be_placed_anywhere_and_reset(admin_client):
    c = admin_client.app.state.container
    base = c.scene.model_dump()
    r = admin_client.put("/api/v1/settings/scene", json={**base, "board_x": 0.4, "board_y": 0.62, "board_scale": 1.3})
    assert r.status_code == 200, r.text
    out = r.json()["config"]
    assert (out["board_x"], out["board_y"], out["board_scale"]) == (0.4, 0.62, 1.3)
    assert admin_client.put("/api/v1/settings/scene", json={**out, "board_x": 1.5}).status_code == 422
    assert admin_client.put("/api/v1/settings/scene", json={**out, "board_scale": 3}).status_code == 422
    r = admin_client.put("/api/v1/settings/scene", json={**out, "board_x": None, "board_y": None})
    assert r.json()["config"]["board_x"] is None
