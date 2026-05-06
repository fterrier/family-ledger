"""simplify importer table

Revision ID: 0005_simplify_importer_table
Revises: 0004_drop_fingerprint
Create Date: 2026-05-06 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0005_simplify_importer_table"
down_revision = "0004_drop_fingerprint"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("importers")
    op.create_table(
        "importers",
        sa.Column("plugin_name", sa.Text(), nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("plugin_name"),
    )


def downgrade() -> None:
    op.drop_table("importers")
    op.create_table(
        "importers",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("plugin_name", sa.Text(), nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sa.UniqueConstraint("plugin_name"),
    )
