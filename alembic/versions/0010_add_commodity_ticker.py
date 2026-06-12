"""add ticker column to commodities

Revision ID: 0010_add_commodity_ticker
Revises: 0009_doctor_query_indexes
Create Date: 2026-06-12 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0010_add_commodity_ticker"
down_revision = "0009_doctor_query_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("commodities", sa.Column("ticker", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("commodities", "ticker")
