"""add import_timestamp to transactions

Revision ID: 0013_add_import_timestamp
Revises: 0012_transaction_source_ids
Create Date: 2026-06-24 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0013_add_import_timestamp"
down_revision = "0012_transaction_source_ids"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("transactions", sa.Column("import_timestamp", sa.DateTime(), nullable=True))
    op.create_index("ix_transactions_import_timestamp", "transactions", ["import_timestamp"])


def downgrade() -> None:
    op.drop_index("ix_transactions_import_timestamp", table_name="transactions")
    op.drop_column("transactions", "import_timestamp")
