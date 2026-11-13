"""Demo store: 6 shelves (KE_01..KE_06), 3 slots each, two sample tea products.

Coordinates in metres. Floor spans x∈[-6,6], z∈[-8,8]; the camera looks from +z (door
side) towards the counter at -z. Each shelf faces +z; stand positions are in front of it,
wait positions beside it (SPEC C4)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from app.config import REPO_DIR
from app.models import MediaAsset, Product, ProductAlias, Shelf, ShelfSlot
from app.services.media import store_image
from app.text_norm import normalize_vi

SHELF_W, SHELF_D, SHELF_H = 2.4, 0.6, 1.6
SLOT_XS = (-0.7, 0.0, 0.7)
SLOT_Y = 0.55  # top of the middle board — reachable by a ~1 m tall Chibi
SAMPLE_DIR = REPO_DIR / "assets" / "sample-products"
DISCLAIMER = "Thực phẩm này không phải là thuốc và không có tác dụng thay thế thuốc chữa bệnh."

SHELVES = [
    ("KE_01", "Kệ 1", -3.0, -3.5), ("KE_02", "Kệ 2", 3.0, -3.5),
    ("KE_03", "Kệ 3", -3.0, 0.0), ("KE_04", "Kệ 4", 3.0, 0.0),
    ("KE_05", "Kệ 5", -3.0, 3.5), ("KE_06", "Kệ 6", 3.0, 3.5),
]

PRODUCTS = [
    {
        "id": "TRA_CA_GAI_LEO", "sku": "DEMO-TCGL-01", "name": "Trà cà gai leo", "price": 85000,
        "image": "tra_ca_gai_leo.png", "shelf": "KE_02", "slot": "S2",
        "aliases": [("cà gai leo", False), ("trà gai leo", False), ("trà", True)],
    },
    {
        "id": "TRA_BA_KICH", "sku": "DEMO-TBK-01", "name": "Trà ba kích", "price": 95000,
        "image": "tra_ba_kich.png", "shelf": "KE_03", "slot": "S2",
        "aliases": [("ba kích", False), ("trà", True)],
    },
]


def shelf_geometry(x: float, z: float) -> dict:
    front = z + SHELF_D / 2 + 0.55
    return {
        "transform": {"x": x, "z": z, "rot": 0.0, "w": SHELF_W, "d": SHELF_D, "h": SHELF_H},
        "stand_positions": [{"x": round(x + dx, 3), "z": round(front, 3)} for dx in SLOT_XS],
        "wait_positions": [{"x": round(x - 1.75, 3), "z": round(front, 3)},
                           {"x": round(x + 1.75, 3), "z": round(front, 3)}],
    }


def seed_demo(db, media_dir: Path, *, verify_prices: bool = True) -> dict[str, int]:
    created = {"shelves": 0, "products": 0}
    with db.session() as s:
        for code, name, x, z in SHELVES:
            if s.execute(select(Shelf).where(Shelf.code == code)).scalar_one_or_none():
                continue
            g = shelf_geometry(x, z)
            sh = Shelf(code=code, name=name, transform=g["transform"], waypoints=[],
                       stand_positions=g["stand_positions"], wait_positions=g["wait_positions"])
            for i, dx in enumerate(SLOT_XS, start=1):
                sh.slots.append(ShelfSlot(code=f"S{i}", slot_transform={"x": dx, "y": SLOT_Y, "z": SHELF_D / 2 - 0.12}))
            s.add(sh)
            created["shelves"] += 1
        s.flush()

        for spec in PRODUCTS:
            if s.get(Product, spec["id"]):
                continue
            stored = store_image(media_dir, (SAMPLE_DIR / spec["image"]).read_bytes())
            asset = s.execute(select(MediaAsset).where(MediaAsset.sha256 == stored.sha256)).scalar_one_or_none()
            if asset is None:
                asset = MediaAsset(kind="image", file_path=stored.rel_path, sha256=stored.sha256,
                                   mime=stored.mime, size_bytes=stored.size_bytes)
                s.add(asset)
                s.flush()
            p = Product(
                id=spec["id"], sku=spec["sku"], name=spec["name"], price=spec["price"], currency="VND",
                price_verified_at=datetime.now(UTC) if verify_prices else None, status="approved",
                claim_text=None, disclaimer=DISCLAIMER, image_asset_id=asset.id,
                box_size={"w": 0.2, "h": 0.28, "d": 0.08},
            )
            for alias, generic in spec["aliases"]:
                p.aliases.append(ProductAlias(alias=alias, alias_normalized=normalize_vi(alias), is_generic=generic))
            s.add(p)
            s.flush()
            slot = s.execute(select(ShelfSlot).join(Shelf).where(Shelf.code == spec["shelf"],
                                                                  ShelfSlot.code == spec["slot"])).scalar_one()
            slot.product_id = p.id
            created["products"] += 1
    return created
