"""add tags column to transactions

Revision ID: 0011_add_transaction_tags
Revises: 0010_add_commodity_ticker
Create Date: 2026-06-14 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0011_add_transaction_tags"
down_revision = "0010_add_commodity_ticker"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column("tags", sa.JSON(), server_default=sa.text("'[]'"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("transactions", "tags")
