"""viewer profiles (khách quen)

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-17 09:30:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # the app also creates this table at start-up when it is missing (the desktop app starts the
    # server without running migrations): only create it here if it is not there yet
    if sa.inspect(op.get_bind()).has_table("viewer_profiles"):
        return
    op.create_table('viewer_profiles',
    sa.Column('key', sa.String(length=160), nullable=False),
    sa.Column('kind', sa.String(length=8), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('first_seen', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_seen', sa.DateTime(timezone=True), nullable=False),
    sa.Column('visits', sa.Integer(), nullable=False),
    sa.Column('streak', sa.Integer(), nullable=False),
    sa.Column('last_seq', sa.Integer(), nullable=False),
    sa.Column('total_watch_s', sa.Float(), nullable=False),
    sa.Column('best_level', sa.Integer(), nullable=False),
    sa.Column('cur_watch_s', sa.Float(), nullable=False),
    sa.Column('cur_level', sa.Integer(), nullable=False),
    sa.PrimaryKeyConstraint('key')
    )
    op.create_index('ix_viewer_profiles_last_seen', 'viewer_profiles', ['last_seen'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_viewer_profiles_last_seen', table_name='viewer_profiles')
    op.drop_table('viewer_profiles')
