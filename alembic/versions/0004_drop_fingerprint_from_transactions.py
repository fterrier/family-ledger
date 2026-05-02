"""drop fingerprint from transactions

Revision ID: 0004_drop_fingerprint_from_transactions
Revises: 0003_add_posting_narration
Create Date: 2026-05-02 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "0004_drop_fingerprint_from_transactions"
down_revision = "0003_add_posting_narration"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("transactions_fingerprint_idx", table_name="transactions")
    op.drop_column("transactions", "fingerprint")


def downgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column("fingerprint", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("transactions_fingerprint_idx", "transactions", ["fingerprint"])
