"""SQLAlchemy models — one table per entry in SPEC.md section E (+ admin_sessions).

Schema changes go through Alembic migrations (backend/alembic/versions); the app never
calls create_all() outside of tests."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class AdminUser(Base):
    __tablename__ = "admin_users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(32), default="operator", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AdminSession(Base):
    __tablename__ = "admin_sessions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    admin_id: Mapped[int] = mapped_column(ForeignKey("admin_users.id", ondelete="CASCADE"))
    csrf_token: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    encrypted_value: Mapped[str] = mapped_column(Text, nullable=False)
    is_secret: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LiveSessionRow(Base):
    __tablename__ = "live_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    url: Mapped[str | None] = mapped_column(String(512))
    unique_id: Mapped[str | None] = mapped_column(String(64))
    room_id: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class LiveEventRow(Base):
    __tablename__ = "live_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("live_sessions.id", ondelete="CASCADE"))
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    source_event_id: Mapped[str] = mapped_column(String(128), nullable=False)
    dedup_mode: Mapped[str] = mapped_column(String(16), default="exact")
    platform_user_id: Mapped[str | None] = mapped_column(String(128))
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    safe_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("session_id", "provider", "source_event_id", name="uq_live_event_source"),
        Index("ix_live_events_observed_at", "observed_at"),
    )


class Viewer(Base):
    __tablename__ = "viewers"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("live_sessions.id", ondelete="CASCADE"))
    platform_user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    unique_id: Mapped[str | None] = mapped_column(String(64))
    nickname: Mapped[str] = mapped_column(String(128), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (UniqueConstraint("session_id", "platform_user_id", name="uq_viewer"),)


class AvatarRow(Base):
    __tablename__ = "avatars"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    viewer_id: Mapped[int] = mapped_column(ForeignKey("viewers.id", ondelete="CASCADE"), unique=True)
    appearance_seed: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(String(32), default="idle")
    position: Mapped[dict | None] = mapped_column(JSON)
    last_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MediaAsset(Base):
    __tablename__ = "media_assets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # image | model
    file_path: Mapped[str] = mapped_column(String(256), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    mime: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Product(Base):
    __tablename__ = "products"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # e.g. TRA_CA_GAI_LEO
    sku: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    price: Mapped[int | None] = mapped_column(Integer)  # VND, integer
    currency: Mapped[str] = mapped_column(String(8), default="VND")
    price_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|approved|disabled
    claim_text: Mapped[str | None] = mapped_column(Text)
    disclaimer: Mapped[str | None] = mapped_column(Text)
    image_asset_id: Mapped[int | None] = mapped_column(ForeignKey("media_assets.id"))
    model_asset_id: Mapped[int | None] = mapped_column(ForeignKey("media_assets.id"))
    box_size: Mapped[dict | None] = mapped_column(JSON)  # {"w":..,"h":..,"d":..} metres
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    aliases: Mapped[list[ProductAlias]] = relationship(
        back_populates="product", cascade="all, delete-orphan", order_by="ProductAlias.id"
    )
    image_asset: Mapped[MediaAsset | None] = relationship(foreign_keys=[image_asset_id])

    @property
    def approved(self) -> bool:
        return self.status == "approved" and self.deleted_at is None


class ProductAlias(Base):
    __tablename__ = "product_aliases"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    alias: Mapped[str] = mapped_column(String(200), nullable=False)
    alias_normalized: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    is_generic: Mapped[bool] = mapped_column(Boolean, default=False)
    product: Mapped[Product] = relationship(back_populates="aliases")
    __table_args__ = (UniqueConstraint("product_id", "alias_normalized", name="uq_alias"),)


class Shelf(Base):
    __tablename__ = "shelves"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)  # KE_02
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    transform: Mapped[dict] = mapped_column(JSON, nullable=False)  # {x,z,rot,w,d,h}
    waypoints: Mapped[list] = mapped_column(JSON, default=list)
    stand_positions: Mapped[list] = mapped_column(JSON, default=list)  # [{x,z}]
    wait_positions: Mapped[list] = mapped_column(JSON, default=list)
    slots: Mapped[list[ShelfSlot]] = relationship(
        back_populates="shelf", cascade="all, delete-orphan", order_by="ShelfSlot.id"
    )


class ShelfSlot(Base):
    __tablename__ = "shelf_slots"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    shelf_id: Mapped[int] = mapped_column(ForeignKey("shelves.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(32), nullable=False)  # S1
    product_id: Mapped[str | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"))
    slot_transform: Mapped[dict] = mapped_column(JSON, nullable=False)  # {x,y,z} local
    pickup_transform: Mapped[dict | None] = mapped_column(JSON)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    shelf: Mapped[Shelf] = relationship(back_populates="slots")
    __table_args__ = (UniqueConstraint("shelf_id", "code", name="uq_slot"),)


class ActionJob(Base):
    __tablename__ = "action_jobs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    command_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    session_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    viewer_key: Mapped[str] = mapped_column(String(160), nullable=False)
    avatar_id: Mapped[str] = mapped_column(String(64), nullable=False)
    product_id: Mapped[str | None] = mapped_column(String(64))
    shelf_code: Mapped[str | None] = mapped_column(String(32))
    stand_index: Mapped[int | None] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(128))
    priority: Mapped[int] = mapped_column(Integer, default=50)
    parent_event_id: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class AiMessage(Base):
    __tablename__ = "ai_messages"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[str | None] = mapped_column(String(64))
    viewer_id: Mapped[int | None] = mapped_column(Integer)
    input: Mapped[str] = mapped_column(Text, nullable=False)
    draft: Mapped[str | None] = mapped_column(Text)
    approved_by_host: Mapped[bool] = mapped_column(Boolean, default=False)
    model: Mapped[str | None] = mapped_column(String(64))
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProviderHealth(Base):
    __tablename__ = "provider_health"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str | None] = mapped_column(String(64))


class DailyUsage(Base):
    __tablename__ = "daily_usage"
    day: Mapped[datetime] = mapped_column(Date, primary_key=True)
    model: Mapped[str] = mapped_column(String(64), primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    estimated_usd: Mapped[float] = mapped_column(Float, default=0.0)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admin_id: Mapped[int | None] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    resource: Mapped[str] = mapped_column(String(200), nullable=False)
    detail: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
