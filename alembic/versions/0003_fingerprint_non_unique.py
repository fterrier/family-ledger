"""make transaction fingerprint non-unique

Revision ID: 0003_fingerprint_non_unique
Revises: 0002_account_name
Create Date: 2026-04-20 00:00:00
"""

from __future__ import annotations

from alembic import op

revision = "0003_fingerprint_non_unique"
down_revision = "0002_account_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS transactions_fingerprint_idx")
    op.execute("ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_fingerprint_key")
    op.create_index("transactions_fingerprint_idx", "transactions", ["fingerprint"], unique=False)


def downgrade() -> None:
    op.drop_index("transactions_fingerprint_idx", table_name="transactions")
    op.create_unique_constraint("transactions_fingerprint_key", "transactions", ["fingerprint"])
