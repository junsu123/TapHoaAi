"""Every box on the LIVE screen can be switched off and placed (dashboard → Bố cục màn hình LIVE)."""

import pytest
from pydantic import ValidationError

from app.services.scene_config import SceneConfig


def test_every_box_is_on_and_in_its_default_spot_by_default():
    c = SceneConfig()
    for f in ("stage_board_enabled", "game_board_enabled", "caption_enabled", "product_card_enabled",
              "owner_bubble_enabled", "status_badge_enabled", "board_enabled", "upcoming_enabled", "banner_enabled"):
        assert getattr(c, f) is True, f
    for k in ("banner", "caption", "product_card", "badges", "board", "stage_board", "upcoming", "game"):
        assert getattr(c, f"{k}_x") is None and getattr(c, f"{k}_y") is None and getattr(c, f"{k}_scale") == 1.0


def test_spots_are_kept_and_checked():
    c = SceneConfig(caption_x=0.1, caption_y=0.05, caption_scale=0.5, badges_x=0.6, badges_y=0.9, caption_enabled=False)
    d = SceneConfig(**c.model_dump())
    assert (d.caption_x, d.caption_y, d.caption_scale, d.caption_enabled) == (0.1, 0.05, 0.5, False)
    assert d.badges_y == 0.9
    SceneConfig(board_scale=0.4)  # smaller boxes than before are fine now
    with pytest.raises(ValidationError):
        SceneConfig(banner_scale=0.3)
    with pytest.raises(ValidationError):
        SceneConfig(caption_x=1.2)
