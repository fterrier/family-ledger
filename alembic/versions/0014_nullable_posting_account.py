"""nullable posting account_id; add transactions.updated_at

Revision ID: 0014_nullable_posting_account
Revises: 0013_add_import_timestamp
Create Date: 2026-08-08 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0014_nullable_posting_account"
down_revision = "0013_add_import_timestamp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("postings", "account_id", existing_type=sa.BigInteger(), nullable=True)
    op.add_column(
        "transactions",
        sa.Column(
            "updated_at",
            sa.BigInteger(),
            nullable=False,
            # An opaque version token (Unix epoch seconds), not a formatted
            # timestamp — see current_update_time() in models/ledger.py.
            # Backfilled here for pre-existing rows; the application always
            # sets its own value on every subsequent create/mutation.
            server_default=sa.text("extract(epoch from now())::bigint"),
        ),
    )


def downgrade() -> None:
    op.drop_column("transactions", "updated_at")
    op.alter_column("postings", "account_id", existing_type=sa.BigInteger(), nullable=False)
