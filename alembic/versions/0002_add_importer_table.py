"""add importer table

Revision ID: 0002_add_importer_table
Revises: 0001_initial_ledger_schema
Create Date: 2026-04-26 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0002_add_importer_table"
down_revision = "0001_initial_ledger_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
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


def downgrade() -> None:
    op.drop_table("importers")
