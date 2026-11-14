from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

_PRODUCT_ID = re.compile(r"^[A-Z0-9_]{2,64}$")
FACE_NAMES = ("left", "right", "back", "top", "bottom")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _check_faces(v: dict[str, int | None] | None) -> dict[str, int | None] | None:
    if v is not None and not set(v) <= set(FACE_NAMES):
        raise ValueError("Mặt hộp chỉ gồm: left, right, back, top, bottom")
    return v


def _check_color(v: str | None) -> str | None:
    if v is not None and v != "" and not _HEX.match(v):
        raise ValueError("Màu phải có dạng #RRGGBB")
    return v or None


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class SetupIn(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")
    password: str = Field(min_length=10, max_length=256)


class MeOut(BaseModel):
    username: str
    role: str
    csrf_token: str


class ConnectIn(BaseModel):
    url: str = Field(max_length=600)
    policy_ack: bool = False  # NFR-12: operator confirmed the Shop LIVE policy checklist


class LiveSettingsPatch(BaseModel):
    sign_api_key: str | None = Field(default=None, max_length=300)


class DemoEventIn(BaseModel):
    type: Literal["COMMENT", "JOIN", "LIKE", "FOLLOW", "GIFT", "SPAWN_RANDOM"] = "COMMENT"
    raw: str | None = Field(default=None, max_length=400)
    unique_id: str | None = Field(default=None, max_length=32)
    nickname: str | None = Field(default=None, max_length=64)
    text: str | None = Field(default=None, max_length=300)
    count: int | None = Field(default=None, ge=1, le=100)
    gift_id: str | None = None
    gift_name: str | None = None
    repeat_count: int | None = Field(default=None, ge=1, le=10000)
    repeat_end: bool | None = None
    streakable: bool | None = None
    group_id: str | None = None
    event_id: str | None = Field(default=None, max_length=64)
    seed: int | None = None


class AliasIn(BaseModel):
    alias: str = Field(min_length=1, max_length=200)
    is_generic: bool = False
    priority: int = 0


class AliasesIn(BaseModel):
    aliases: list[AliasIn]
    replace: bool = False


class ProductIn(BaseModel):
    id: str
    sku: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    price: int | None = Field(default=None, ge=0, le=1_000_000_000)
    currency: str = "VND"
    status: Literal["draft", "approved", "disabled"] = "draft"
    claim_text: str | None = Field(default=None, max_length=2000)
    disclaimer: str | None = Field(default=None, max_length=1000)
    image_asset_id: int | None = None
    model_asset_id: int | None = None
    box_size: dict[str, float] | None = None
    face_assets: dict[str, int | None] | None = None
    box_color: str | None = None
    card_image_asset_id: int | None = None
    verify_price: bool = False

    _faces = field_validator("face_assets")(classmethod(lambda cls, v: _check_faces(v)))
    _color = field_validator("box_color")(classmethod(lambda cls, v: _check_color(v)))

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not _PRODUCT_ID.match(v):
            raise ValueError("Mã sản phẩm chỉ gồm A-Z, 0-9, dấu gạch dưới (ví dụ TRA_CA_GAI_LEO)")
        return v


class ProductPatch(BaseModel):
    sku: str | None = Field(default=None, max_length=64)
    name: str | None = Field(default=None, max_length=200)
    price: int | None = Field(default=None, ge=0, le=1_000_000_000)
    status: Literal["draft", "approved", "disabled"] | None = None
    claim_text: str | None = Field(default=None, max_length=2000)
    disclaimer: str | None = Field(default=None, max_length=1000)
    image_asset_id: int | None = None
    model_asset_id: int | None = None
    box_size: dict[str, float] | None = None
    face_assets: dict[str, int | None] | None = None
    box_color: str | None = None
    card_image_asset_id: int | None = None
    verify_price: bool = False

    _faces = field_validator("face_assets")(classmethod(lambda cls, v: _check_faces(v)))
    _color = field_validator("box_color")(classmethod(lambda cls, v: _check_color(v)))


class ProductOut(BaseModel):
    id: str
    sku: str
    name: str
    price: int | None
    currency: str
    price_verified_at: datetime | None
    status: str
    claim_text: str | None
    disclaimer: str | None
    image_url: str | None
    model_url: str | None
    box_size: dict[str, float] | None
    face_urls: dict[str, str] = {}
    box_color: str | None = None
    card_image_url: str | None = None
    aliases: list[dict[str, Any]]
    location: dict[str, str] | None
    updated_at: datetime | None


class SlotPatch(BaseModel):
    product_id: str | None


class GameSettingsPatch(BaseModel):
    idle_exit_minutes: float = Field(ge=1, le=60)


class AiPauseIn(BaseModel):
    paused: bool


class ShelfIn(BaseModel):
    code: str = Field(pattern=r"^[A-Z0-9_]{2,32}$")
    name: str = Field(min_length=1, max_length=100)
    x: float = Field(ge=-6, le=6)
    z: float = Field(ge=-8, le=8)
    rot: Literal[0, 90, 180, 270] = 0


class ShelfPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    x: float | None = Field(default=None, ge=-6, le=6)
    z: float | None = Field(default=None, ge=-8, le=8)
    rot: Literal[0, 90, 180, 270] | None = None
