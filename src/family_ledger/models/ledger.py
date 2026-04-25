from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from family_ledger.models.base import Base

json_type = JSON().with_variant(JSONB, "postgresql")
id_type = BigInteger().with_variant(Integer, "sqlite")


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint(
            "effective_end_date IS NULL OR effective_end_date >= effective_start_date",
            name="accounts_effective_date_range_check",
        ),
    )

    id: Mapped[int] = mapped_column(id_type, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, unique=True)
    account_name: Mapped[str] = mapped_column(Text, unique=True)
    effective_start_date: Mapped[date] = mapped_column(Date)
    effective_end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    entity_metadata: Mapped[dict[str, Any]] = mapped_column(json_type, default=dict)

    postings: Mapped[list[Posting]] = relationship(back_populates="account")
    balance_assertions: Mapped[list[BalanceAssertion]] = relationship(back_populates="account")


class Commodity(Base):
    __tablename__ = "commodities"

    id: Mapped[int] = mapped_column(id_type, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, unique=True)
    symbol: Mapped[str] = mapped_column(Text, unique=True)
    entity_metadata: Mapped[dict[str, Any]] = mapped_column(json_type, default=dict)


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(id_type, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, unique=True)
    transaction_date: Mapped[date] = mapped_column(Date)
    payee: Mapped[str | None] = mapped_column(Text, nullable=True)
    narration: Mapped[str | None] = mapped_column(Text, nullable=True)
    entity_metadata: Mapped[dict[str, Any]] = mapped_column(json_type, default=dict)
    source_native_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    fingerprint: Mapped[str] = mapped_column(Text, index=True)

    postings: Mapped[list[Posting]] = relationship(
        back_populates="transaction",
        cascade="all, delete-orphan",
        order_by="Posting.posting_order",
    )


class Posting(Base):
    __tablename__ = "postings"
    __table_args__ = (
        UniqueConstraint("transaction_id", "posting_order", name="postings_transaction_order_key"),
        CheckConstraint(
            "(cost_per_unit IS NULL) = (cost_symbol IS NULL)",
            name="postings_cost_pair_check",
        ),
        CheckConstraint(
            "(price_per_unit IS NULL) = (price_symbol IS NULL)",
            name="postings_price_pair_check",
        ),
    )

    id: Mapped[int] = mapped_column(id_type, primary_key=True, autoincrement=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id", ondelete="CASCADE"))
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"))
    posting_order: Mapped[int] = mapped_column(Integer)
    units_amount: Mapped[Decimal] = mapped_column(Numeric)
    units_symbol: Mapped[str] = mapped_column(Text)
    cost_per_unit: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    cost_symbol: Mapped[str | None] = mapped_column(Text, nullable=True)
    price_per_unit: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    price_symbol: Mapped[str | None] = mapped_column(Text, nullable=True)
    entity_metadata: Mapped[dict[str, Any]] = mapped_column(json_type, default=dict)

    transaction: Mapped[Transaction] = relationship(back_populates="postings")
    account: Mapped[Account] = relationship(back_populates="postings")


class Price(Base):
    __tablename__ = "prices"
    __table_args__ = (
        UniqueConstraint("price_date", "base_symbol", "quote_symbol", name="prices_date_pair_key"),
    )

    id: Mapped[int] = mapped_column(id_type, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, unique=True)
    price_date: Mapped[date] = mapped_column(Date)
    base_symbol: Mapped[str] = mapped_column(Text)
    quote_symbol: Mapped[str] = mapped_column(Text)
    price_per_unit: Mapped[Decimal] = mapped_column(Numeric)
    entity_metadata: Mapped[dict[str, Any]] = mapped_column(json_type, default=dict)


class BalanceAssertion(Base):
    __tablename__ = "balance_assertions"
    __table_args__ = (
        UniqueConstraint(
            "assertion_date",
            "account_id",
            "symbol",
            name="balance_assertions_date_account_symbol_key",
        ),
    )

    id: Mapped[int] = mapped_column(id_type, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, unique=True)
    assertion_date: Mapped[date] = mapped_column(Date)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"))
    amount: Mapped[Decimal] = mapped_column(Numeric)
    symbol: Mapped[str] = mapped_column(Text)
    entity_metadata: Mapped[dict[str, Any]] = mapped_column(json_type, default=dict)

    account: Mapped[Account] = relationship(back_populates="balance_assertions")
