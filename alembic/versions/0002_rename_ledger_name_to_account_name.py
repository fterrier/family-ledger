"""rename ledger_name to account_name

Revision ID: 0002_rename_ledger_name_to_account_name
Revises: 0001_initial_ledger_schema
Create Date: 2026-04-20 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0002_rename_ledger_name_to_account_name"
down_revision = "0001_initial_ledger_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("accounts")}
    if "ledger_name" in columns and "account_name" not in columns:
        op.alter_column("accounts", "ledger_name", new_column_name="account_name")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("accounts")}
    if "account_name" in columns and "ledger_name" not in columns:
        op.alter_column("accounts", "account_name", new_column_name="ledger_name")
