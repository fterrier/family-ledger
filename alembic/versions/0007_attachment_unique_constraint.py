"""add unique constraint on attachments (account_id, original_filename, attachment_date)

Revision ID: 0007_attachment_unique_constraint
Revises: 0006_add_attachments_table
Create Date: 2026-05-21 00:00:00
"""

from __future__ import annotations

from alembic import op

revision = "0007_attachment_unique"
down_revision = "0006_add_attachments_table"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "attachments_account_filename_date_key",
        "attachments",
        ["account_id", "original_filename", "attachment_date"],
    )


def downgrade() -> None:
    op.drop_constraint("attachments_account_filename_date_key", "attachments", type_="unique")
