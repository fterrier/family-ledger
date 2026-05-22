"""add pending_upload to attachments status check constraint

Revision ID: 0008_attachment_pending_upload
Revises: 0007_attachment_unique
Create Date: 2026-05-22 00:00:00
"""

from __future__ import annotations

from alembic import op

revision = "0008_attachment_pending_upload"
down_revision = "0007_attachment_unique"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("attachments_status_check", "attachments", type_="check")
    op.create_check_constraint(
        "attachments_status_check",
        "attachments",
        "status IN ('pending_upload', 'pending_storage', 'stored', 'failed', 'timed_out')",
    )


def downgrade() -> None:
    op.drop_constraint("attachments_status_check", "attachments", type_="check")
    op.create_check_constraint(
        "attachments_status_check",
        "attachments",
        "status IN ('pending_storage', 'stored', 'failed', 'timed_out')",
    )
