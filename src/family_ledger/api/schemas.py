from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class MoneyValue(BaseModel):
    amount: Decimal
    symbol: str


class PostingPayload(BaseModel):
    account: str
    units: MoneyValue
    cost: MoneyValue | None = None
    price: MoneyValue | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class ImportMetadata(BaseModel):
    source_native_id: str | None = None
    fingerprint: str | None = None


class AccountResource(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    ledger_name: str
    effective_start_date: date
    effective_end_date: date | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class CommodityResource(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    symbol: str
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class PriceResource(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    price_date: date
    base_symbol: str
    quote: MoneyValue
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class BalanceAssertionResource(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    assertion_date: date
    account: str
    amount: MoneyValue
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class TransactionResource(BaseModel):
    name: str
    transaction_date: date
    payee: str | None = None
    narration: str | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)
    import_metadata: ImportMetadata | None = None
    postings: list[PostingPayload]


class CreateAccountRequest(BaseModel):
    account: AccountResource


class ListAccountsResponse(BaseModel):
    accounts: list[AccountResource]


class CreateCommodityRequest(BaseModel):
    commodity: CommodityResource


class ListCommoditiesResponse(BaseModel):
    commodities: list[CommodityResource]


class CreateTransactionRequest(BaseModel):
    transaction: TransactionResource


class CreatePriceRequest(BaseModel):
    price: PriceResource


class CreateBalanceAssertionRequest(BaseModel):
    balance_assertion: BalanceAssertionResource
