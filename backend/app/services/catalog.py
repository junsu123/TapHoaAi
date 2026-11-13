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

from app.models import Product, Shelf
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
    box_size: dict[str, float]
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
            "store": {"width": 12.0, "depth": 16.0, "door": {"x": 0.0, "z": 7.6},
                      "counter": {"x": 0.0, "z": -6.6, "w": 3.2, "d": 0.8}},
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
                 "currency": p.currency, "image_url": p.image_url, "box_size": p.box_size}
                for p in self.products.values()
            ],
        }


def build_catalog(db, version: int, price_valid_days: int = 30) -> Catalog:
    cat = Catalog(version=version)
    now = datetime.now(UTC)
    with db.session() as s:
        products = s.execute(
            select(Product).options(selectinload(Product.aliases), selectinload(Product.image_asset))
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
            cat.products[p.id] = CatalogProduct(
                id=p.id, sku=p.sku, name=p.name,
                display_price=p.price if price_ok else None, currency=p.currency,
                image_url=image_url, box_size=p.box_size or DEFAULT_BOX,
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
