from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class MoneyValue(BaseModel):
    amount: Decimal
    symbol: str


class NormalizeMoneyValue(BaseModel):
    amount: Decimal
    symbol: str | None = None


class NormalizePriceValue(BaseModel):
    amount: Decimal | None = None
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


class AccountData(BaseModel):
    account_name: str
    effective_start_date: date
    effective_end_date: date | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class AccountResource(AccountData):
    model_config = ConfigDict(from_attributes=True)

    name: str


class AccountCreate(AccountData):
    pass


class CommodityData(BaseModel):
    symbol: str
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class CommodityResource(CommodityData):
    model_config = ConfigDict(from_attributes=True)

    name: str


class CommodityCreate(CommodityData):
    pass


class PriceData(BaseModel):
    price_date: date
    base_symbol: str
    quote: MoneyValue
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class PriceResource(PriceData):
    model_config = ConfigDict(from_attributes=True)

    name: str


class PriceCreate(PriceData):
    pass


class BalanceAssertionData(BaseModel):
    assertion_date: date
    account: str
    amount: MoneyValue
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class BalanceAssertionResource(BalanceAssertionData):
    model_config = ConfigDict(from_attributes=True)

    name: str


class BalanceAssertionCreate(BalanceAssertionData):
    pass


class TransactionData(BaseModel):
    transaction_date: date
    payee: str | None = None
    narration: str | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)
    import_metadata: ImportMetadata | None = None
    postings: list[PostingPayload]


class TransactionResource(TransactionData):
    name: str


class TransactionCreate(TransactionData):
    pass


class PostingNormalizePayload(BaseModel):
    account: str
    units: MoneyValue | NormalizeMoneyValue | None = None
    cost: MoneyValue | None = None
    price: MoneyValue | NormalizePriceValue | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class TransactionNormalizeData(BaseModel):
    transaction_date: date
    payee: str | None = None
    narration: str | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)
    import_metadata: ImportMetadata | None = None
    postings: list[PostingNormalizePayload]


class NormalizeTransactionRequest(BaseModel):
    transaction: TransactionNormalizeData


class NormalizeTransactionResponse(BaseModel):
    transaction: TransactionCreate


class CreateAccountRequest(BaseModel):
    account: AccountCreate


class ListAccountsResponse(BaseModel):
    accounts: list[AccountResource]
    next_page_token: str | None = None


class CreateCommodityRequest(BaseModel):
    commodity: CommodityCreate


class ListCommoditiesResponse(BaseModel):
    commodities: list[CommodityResource]
    next_page_token: str | None = None


class ListTransactionsResponse(BaseModel):
    transactions: list[TransactionResource]
    next_page_token: str | None = None


class CreateTransactionRequest(BaseModel):
    transaction: TransactionNormalizeData


class CreatePriceRequest(BaseModel):
    price: PriceCreate


class CreateBalanceAssertionRequest(BaseModel):
    balance_assertion: BalanceAssertionCreate
