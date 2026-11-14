"""Immutable in-memory snapshot of the approved catalog + store layout.

Rebuilt from the DB whenever a product, alias, shelf or slot changes (T15) and handed to
the matcher and the game snapshot. Only `approved`, non-deleted products appear here,
so neither the matcher nor the AI can ever reference a draft product (PRD-04)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models import MediaAsset, Product, Shelf
from app.services.store_layout import COUNTER, DOOR, STORE_D, STORE_W
from app.text_norm import normalize_vi

DEFAULT_BOX = {"w": 0.2, "h": 0.28, "d": 0.08}


@dataclass(frozen=True)
class CatalogProduct:
    id: str
    sku: str
    name: str
    display_price: int | None  # None when missing or not verified recently
    currency: str
    image_url: str | None
    model_url: str | None
    box_size: dict[str, float]
    face_urls: dict[str, str]
    box_color: str | None
    card_image_url: str | None
    claim_text: str | None
    disclaimer: str | None


@dataclass(frozen=True)
class AliasEntry:
    product_id: str
    normalized: str
    is_generic: bool
    priority: int

    @property
    def tokens(self) -> int:
        return len(self.normalized.split())


@dataclass(frozen=True)
class SlotInfo:
    code: str
    product_id: str | None
    local: dict[str, float]


@dataclass(frozen=True)
class ShelfInfo:
    code: str
    name: str
    transform: dict[str, float]
    stand_positions: list[dict[str, float]]
    wait_positions: list[dict[str, float]]
    slots: list[SlotInfo]


@dataclass
class Catalog:
    version: int = 0
    products: dict[str, CatalogProduct] = field(default_factory=dict)
    aliases: list[AliasEntry] = field(default_factory=list)
    shelves: dict[str, ShelfInfo] = field(default_factory=dict)
    locations: dict[str, tuple[str, str]] = field(default_factory=dict)  # product -> (shelf, slot)

    def location_of(self, product_id: str) -> tuple[str, str] | None:
        return self.locations.get(product_id)

    def layout_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "store": {"width": STORE_W, "depth": STORE_D, "door": {"x": DOOR["x"], "z": 7.6},
                      "counter": dict(COUNTER)},
            "shelves": [
                {
                    "code": s.code, "name": s.name, "transform": s.transform,
                    "stand_positions": s.stand_positions, "wait_positions": s.wait_positions,
                    "slots": [{"code": sl.code, "product_id": sl.product_id, "local": sl.local} for sl in s.slots],
                }
                for s in self.shelves.values()
            ],
            "products": [
                {"id": p.id, "sku": p.sku, "name": p.name, "price": p.display_price,
                 "currency": p.currency, "image_url": p.image_url, "model_url": p.model_url,
                 "box_size": p.box_size, "face_urls": p.face_urls, "box_color": p.box_color,
                 "card_image_url": p.card_image_url}
                for p in self.products.values()
            ],
        }


def face_urls(s, face_assets: dict | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for face, asset_id in (face_assets or {}).items():
        if asset_id is None:
            continue
        a = s.get(MediaAsset, asset_id)
        if a is not None and a.kind == "image":
            out[face] = f"/media/{a.file_path}"
    return out


def build_catalog(db, version: int, price_valid_days: int = 30) -> Catalog:
    cat = Catalog(version=version)
    now = datetime.now(UTC)
    with db.session() as s:
        products = s.execute(
            select(Product).options(selectinload(Product.aliases), selectinload(Product.image_asset),
                                    selectinload(Product.model_asset), selectinload(Product.card_image_asset))
        ).scalars().all()
        for p in products:
            if not p.approved:
                continue
            verified = p.price_verified_at
            if verified is not None and verified.tzinfo is None:
                verified = verified.replace(tzinfo=UTC)
            price_ok = (
                p.price is not None and verified is not None
                and now - verified <= timedelta(days=price_valid_days)
            )
            image_url = f"/media/{p.image_asset.file_path}" if p.image_asset else None
            model_url = f"/media/{p.model_asset.file_path}" if p.model_asset else None
            cat.products[p.id] = CatalogProduct(
                id=p.id, sku=p.sku, name=p.name,
                display_price=p.price if price_ok else None, currency=p.currency,
                image_url=image_url, model_url=model_url, box_size=p.box_size or DEFAULT_BOX,
                face_urls=face_urls(s, p.face_assets), box_color=p.box_color,
                card_image_url=f"/media/{p.card_image_asset.file_path}" if p.card_image_asset else None,
                claim_text=p.claim_text, disclaimer=p.disclaimer,
            )
            names = {(normalize_vi(p.name), False, 100)}
            for a in p.aliases:
                names.add((a.alias_normalized, a.is_generic, a.priority))
            for norm, generic, prio in names:
                if norm:
                    cat.aliases.append(AliasEntry(p.id, norm, generic, prio))

        shelves = s.execute(select(Shelf).options(selectinload(Shelf.slots)).order_by(Shelf.code)).scalars().all()
        for sh in shelves:
            slots = []
            for sl in sh.slots:
                pid = sl.product_id if (sl.is_active and sl.product_id in cat.products) else None
                slots.append(SlotInfo(sl.code, pid, sl.slot_transform))
                if pid and pid not in cat.locations:
                    cat.locations[pid] = (sh.code, sl.code)
            cat.shelves[sh.code] = ShelfInfo(
                code=sh.code, name=sh.name, transform=sh.transform,
                stand_positions=list(sh.stand_positions or []),
                wait_positions=list(sh.wait_positions or []), slots=slots,
            )
    return cat
