"""TikTok Shop order integration — milestone M6 (SHOP-01/02).

Deliberately empty: orders are never inferred from comments, gifts or game actions.
This module only reports that no authorised connector is configured (T19)."""

from __future__ import annotations


def shop_status() -> dict:
    return {
        "status": "Not configured",
        "label": "Chưa kết nối Shop",
        "orders_verified": False,
        "note": "Cần app/quyền TikTok Shop chính thức và webhook xác thực (mốc M6).",
    }
