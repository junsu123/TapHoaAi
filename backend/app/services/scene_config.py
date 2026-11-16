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
    # led = a big LED screen fixed flat on the back wall (in the 3D shop); tv / board = a frame
    # drawn over the top of the LIVE screen
    banner_style: Literal["led", "tv", "board"] = "led"
    # the shop-owner Chibi: brews tea, stands and bows to greet, serves tea to gift givers
    owner_enabled: bool = True
    owner_name: str = Field("Chủ quán", max_length=24)
    owner_greet_template: str = Field("Xin chào quý khách {ten} đã vào quán!", max_length=120)
    owner_tea_template: str = Field("Mời {ten} dùng trà ạ! Cảm ơn {ten} đã tặng {qua}!", max_length=140)
    owner_buy_template: str = Field("Cảm ơn {ten} đã mua {san_pham} ạ!", max_length=120)
    # honour board: top gift givers and buyers
    board_enabled: bool = True
    board_position: Literal["left", "right"] = "left"
    board_scope: Literal["session", "all"] = "session"  # reset for each LIVE, or keep until reset
    board_size: int = Field(5, ge=3, le=10)
    # dragged to a spot of the host's choosing: top-left corner as a fraction of the 9:16 frame
    # (None = the corner chosen in board_position), and its size
    board_x: float | None = Field(None, ge=0.0, le=0.95)
    board_y: float | None = Field(None, ge=0.0, le=0.95)
    board_scale: float = Field(1.0, ge=0.6, le=1.8)
    # Chibi behaviour (spec V3 §5, §11): autonomous life on/off and how often each kind of
    # activity is picked (relative weights), and how many Chibis may be on screen at once
    chibi_autonomous: bool = True
    chibi_w_browse: int = Field(30, ge=0, le=100)
    chibi_w_explore: int = Field(25, ge=0, le=100)
    chibi_w_idle: int = Field(20, ge=0, le=100)
    chibi_w_social: int = Field(10, ge=0, le=100)
    chibi_w_rest: int = Field(10, ge=0, le=100)
    chibi_w_fun: int = Field(5, ge=0, le=100)
    chibi_max_visible: int = Field(60, ge=10, le=80)
    # dance stage: viewers sign up by commenting "nhảy" / "lên sân khấu"; first come, first served
    stage_enabled: bool = True
    stage_seconds: int = Field(15, ge=8, le=60)  # each performer dances this long
    stage_max_queue: int = Field(30, ge=5, le=100)
    # "center": a round stage in the middle aisle, seen by everybody; "right"/"left": front corner
    stage_side: Literal["center", "right", "left"] = "center"
    stage_layout_v: int = 2  # 1 = saved before the centre stage existed (moved to the centre once)
    # the "Sân khấu" box on the LIVE screen, where the host dragged it (None = default spot)
    stage_board_x: float | None = Field(None, ge=0.0, le=0.95)
    stage_board_y: float | None = Field(None, ge=0.0, le=0.95)
    stage_board_scale: float = Field(1.0, ge=0.6, le=1.8)
    # a viewer's comment (and the owner's reply to it) is only read aloud: no bubble, no caption text
    chat_on_screen: bool = False

    @field_validator("sign_text", "tagline", "owner_name", "owner_greet_template", "owner_tea_template",
                     "owner_buy_template")
    @classmethod
    def _clean(cls, v: str) -> str:
        return " ".join(v.split())


def load_scene(c: AppContainer) -> SceneConfig:
    raw = c.get_setting(CONFIG_KEY)
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and data.get("stage_layout_v", 1) < 2:
                # 0.20/0.21 kept the stage in the front corner by default: it now stands in the middle
                data["stage_side"] = "center"
                data["stage_layout_v"] = 2
            return SceneConfig.model_validate(data)
        except (ValueError, TypeError):
            pass
    return SceneConfig()


def save_scene(c: AppContainer, cfg: SceneConfig) -> None:
    c.set_setting(CONFIG_KEY, cfg.model_dump_json(), secret=False)
    c.scene = cfg
    apply_avatar_cap(c)
    c.hub.send_game({"type": "SCENE_UPDATED", "scene": cfg.model_dump()})
    board = getattr(c, "board", None)
    if board is not None:  # board size / scope may have changed
        board._publish()


def apply_avatar_cap(c: AppContainer) -> None:
    """More viewers than `chibi_max_visible`: the extra ones wait off screen (state kept,
    nothing invented) and come in when someone leaves — spec SUSPEND_LOD."""
    avatars = getattr(c, "avatars", None)
    if avatars is not None:
        avatars.max_visible = max(1, int(c.scene.chibi_max_visible))
