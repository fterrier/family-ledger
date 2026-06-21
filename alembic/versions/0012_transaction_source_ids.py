"""replace source_native_id with source_native_ids array

Revision ID: 0012_transaction_source_ids
Revises: 0011_add_transaction_tags
Create Date: 2026-06-21 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0012_transaction_source_ids"
down_revision = "0011_add_transaction_tags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.add_column(
            "transactions",
            sa.Column("source_native_ids", JSONB(), server_default=sa.text("'[]'"), nullable=False),
        )
        op.execute(
            "UPDATE transactions SET source_native_ids = jsonb_build_array(source_native_id) "
            "WHERE source_native_id IS NOT NULL"
        )
        op.execute(
            "CREATE INDEX ix_transactions_source_native_ids_gin "
            "ON transactions USING GIN (source_native_ids jsonb_path_ops)"
        )
    else:
        op.add_column(
            "transactions",
            sa.Column(
                "source_native_ids", sa.JSON(), server_default=sa.text("'[]'"), nullable=False
            ),
        )
        op.execute(
            "UPDATE transactions SET source_native_ids = json_array(source_native_id) "
            "WHERE source_native_id IS NOT NULL"
        )
    op.drop_index("ix_transactions_source_native_id", table_name="transactions", if_exists=True)
    op.drop_column("transactions", "source_native_id")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.add_column(
            "transactions",
            sa.Column("source_native_id", sa.Text(), nullable=True),
        )
        op.execute(
            "UPDATE transactions SET source_native_id = source_native_ids->>0 "
            "WHERE jsonb_array_length(source_native_ids) > 0"
        )
        op.execute("DROP INDEX IF EXISTS ix_transactions_source_native_ids_gin")
    else:
        op.add_column(
            "transactions",
            sa.Column("source_native_id", sa.Text(), nullable=True),
        )
        op.execute(
            "UPDATE transactions SET source_native_id = json_extract(source_native_ids, '$[0]') "
            "WHERE json_array_length(source_native_ids) > 0"
        )
    op.create_index(
        "ix_transactions_source_native_id", "transactions", ["source_native_id"], unique=True
    )
    op.drop_column("transactions", "source_native_ids")
