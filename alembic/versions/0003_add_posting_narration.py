"""add posting narration

Revision ID: 0003_add_posting_narration
Revises: 0002_add_importer_table
Create Date: 2026-04-30 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0003_add_posting_narration"
down_revision = "0002_add_importer_table"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("postings", sa.Column("narration", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("postings", "narration")
