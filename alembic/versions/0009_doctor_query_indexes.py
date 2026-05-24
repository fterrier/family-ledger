"""add indexes to speed up doctor endpoint queries

Revision ID: 0009_doctor_query_indexes
Revises: 0008_attachment_pending_upload
Create Date: 2026-05-24 00:00:00
"""

from __future__ import annotations

from alembic import op

revision = "0009_doctor_query_indexes"
down_revision = "0008_attachment_pending_upload"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("transactions_date_name_idx", "transactions", ["transaction_date", "name"])
    op.create_index(
        "balance_assertions_date_name_idx", "balance_assertions", ["assertion_date", "name"]
    )


def downgrade() -> None:
    op.drop_index("balance_assertions_date_name_idx", table_name="balance_assertions")
    op.drop_index("transactions_date_name_idx", table_name="transactions")
