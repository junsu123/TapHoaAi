"""Look of the 3D shop and the on-stream product banner.

One JSON document in the settings table; sent to the game page in the snapshot and as
SCENE_UPDATED whenever the shop owner saves it.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field, field_validator

if TYPE_CHECKING:
    from app.container import AppContainer

CONFIG_KEY = "scene_config"

Theme = Literal["herbal", "kawaii"]
THEMES: dict[str, str] = {"herbal": "Tiệm trà thảo mộc", "kawaii": "Tạp hóa Chibi (hồng)"}


class SceneConfig(BaseModel):
    theme: Theme = "herbal"
    sign_text: str = Field("TIỆM TRÀ THẢO MỘC", max_length=32)
    tagline: str = Field("Trà sạch · Thảo mộc Việt", max_length=48)
    banner_enabled: bool = True
    # scroll = products slide past continuously (conveyor); slide = one product at a time
    banner_mode: Literal["scroll", "slide"] = "scroll"
    banner_focus_on_show: bool = True  # show only the product a Chibi is holding while it is shown
    banner_seconds: int = Field(6, ge=2, le=30)  # per product (slide) / time for one product to pass (scroll)
    banner_height: float = Field(0.24, ge=0.15, le=0.4)  # fraction of the 9:16 frame
    banner_show_price: bool = True
    banner_product_ids: list[str] = Field(default_factory=list, max_length=200)  # empty = every product with a photo
    wall_posters: bool = True

    @field_validator("sign_text", "tagline")
    @classmethod
    def _clean(cls, v: str) -> str:
        return " ".join(v.split())


def load_scene(c: AppContainer) -> SceneConfig:
    raw = c.get_setting(CONFIG_KEY)
    if raw:
        try:
            return SceneConfig.model_validate(json.loads(raw))
        except (ValueError, TypeError):
            pass
    return SceneConfig()


def save_scene(c: AppContainer, cfg: SceneConfig) -> None:
    c.set_setting(CONFIG_KEY, cfg.model_dump_json(), secret=False)
    c.scene = cfg
    c.hub.send_game({"type": "SCENE_UPDATED", "scene": cfg.model_dump()})
