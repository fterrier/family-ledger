"""initial ledger schema

Revision ID: 0001_initial_ledger_schema
Revises:
Create Date: 2026-04-19 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision = "0001_initial_ledger_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "accounts",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("account_name", sa.Text(), nullable=False),
        sa.Column("effective_start_date", sa.Date(), nullable=False),
        sa.Column("effective_end_date", sa.Date(), nullable=True),
        sa.Column(
            "entity_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "effective_end_date IS NULL OR effective_end_date >= effective_start_date",
            name="accounts_effective_date_range_check",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_name"),
        sa.UniqueConstraint("name"),
    )

    op.create_table(
        "commodities",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("symbol", sa.Text(), nullable=False),
        sa.Column(
            "entity_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sa.UniqueConstraint("symbol"),
    )

    op.create_table(
        "transactions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("transaction_date", sa.Date(), nullable=False),
        sa.Column("payee", sa.Text(), nullable=True),
        sa.Column("narration", sa.Text(), nullable=True),
        sa.Column(
            "entity_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("source_native_id", sa.Text(), nullable=True),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index("transactions_fingerprint_idx", "transactions", ["fingerprint"], unique=False)
    op.create_index(
        "transactions_source_native_id_key",
        "transactions",
        ["source_native_id"],
        unique=True,
        postgresql_where=sa.text("source_native_id IS NOT NULL"),
    )

    op.create_table(
        "prices",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("price_date", sa.Date(), nullable=False),
        sa.Column("base_symbol", sa.Text(), nullable=False),
        sa.Column("quote_symbol", sa.Text(), nullable=False),
        sa.Column("price_per_unit", sa.Numeric(), nullable=False),
        sa.Column(
            "entity_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sa.UniqueConstraint(
            "price_date", "base_symbol", "quote_symbol", name="prices_date_pair_key"
        ),
    )

    op.create_table(
        "balance_assertions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("assertion_date", sa.Date(), nullable=False),
        sa.Column("account_id", sa.BigInteger(), nullable=False),
        sa.Column("amount", sa.Numeric(), nullable=False),
        sa.Column("symbol", sa.Text(), nullable=False),
        sa.Column(
            "entity_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sa.UniqueConstraint(
            "assertion_date",
            "account_id",
            "symbol",
            name="balance_assertions_date_account_symbol_key",
        ),
    )
    op.create_index(
        "balance_assertions_account_id_assertion_date_idx",
        "balance_assertions",
        ["account_id", "assertion_date"],
        unique=False,
    )

    op.create_table(
        "postings",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("transaction_id", sa.BigInteger(), nullable=False),
        sa.Column("account_id", sa.BigInteger(), nullable=False),
        sa.Column("posting_order", sa.Integer(), nullable=False),
        sa.Column("units_amount", sa.Numeric(), nullable=False),
        sa.Column("units_symbol", sa.Text(), nullable=False),
        sa.Column("cost_per_unit", sa.Numeric(), nullable=True),
        sa.Column("cost_symbol", sa.Text(), nullable=True),
        sa.Column("price_per_unit", sa.Numeric(), nullable=True),
        sa.Column("price_symbol", sa.Text(), nullable=True),
        sa.Column(
            "entity_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(cost_per_unit IS NULL) = (cost_symbol IS NULL)",
            name="postings_cost_pair_check",
        ),
        sa.CheckConstraint(
            "(price_per_unit IS NULL) = (price_symbol IS NULL)",
            name="postings_price_pair_check",
        ),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "transaction_id", "posting_order", name="postings_transaction_order_key"
        ),
    )
    op.create_index("postings_account_id_idx", "postings", ["account_id"], unique=False)
    op.create_index(
        "postings_transaction_id_posting_order_idx",
        "postings",
        ["transaction_id", "posting_order"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "postings_transaction_id_posting_order_idx",
        table_name="postings",
    )
    op.drop_index("postings_account_id_idx", table_name="postings")
    op.drop_table("postings")
    op.drop_index(
        "balance_assertions_account_id_assertion_date_idx", table_name="balance_assertions"
    )
    op.drop_table("balance_assertions")
    op.drop_table("prices")
    op.drop_index("transactions_fingerprint_idx", table_name="transactions")
    op.drop_index("transactions_source_native_id_key", table_name="transactions")
    op.drop_table("transactions")
    op.drop_table("commodities")
    op.drop_table("accounts")
