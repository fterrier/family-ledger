"""add issues

Revision ID: 0004_add_issues
Revises: 0003_fingerprint_non_unique
Create Date: 2026-04-23 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0004_add_issues"
down_revision = "0003_fingerprint_non_unique"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "issues",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("target", sa.Text(), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column(
            "message",
            sa.Text(),
            nullable=False,
        ),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index("issues_target_idx", "issues", ["target"], unique=False)
    op.create_index("issues_code_idx", "issues", ["code"], unique=False)


def downgrade() -> None:
    op.drop_index("issues_code_idx", table_name="issues")
    op.drop_index("issues_target_idx", table_name="issues")
    op.drop_table("issues")
