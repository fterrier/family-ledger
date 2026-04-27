from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from family_ledger.importers.base import EntityCounts as EntityCounts  # noqa: F401
from family_ledger.importers.base import EntityErrors as EntityErrors  # noqa: F401
from family_ledger.importers.base import ImportResult as ImportResult  # noqa: F401


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


class NormalizeIssue(BaseModel):
    code: str
    severity: str
    message: str
    details: dict[str, str] = Field(default_factory=dict)


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
    issues: list[NormalizeIssue] = Field(default_factory=list)


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


class UpdateTransactionRequest(BaseModel):
    transaction: TransactionNormalizeData
    update_mask: str | None = None


class DoctorIssue(BaseModel):
    target: str
    code: str
    severity: str
    message: str
    details: dict[str, str] = Field(default_factory=dict)


class DoctorLedgerRequest(BaseModel):
    pass


class DoctorLedgerResponse(BaseModel):
    issues: list[DoctorIssue] = Field(default_factory=list)


class CreatePriceRequest(BaseModel):
    price: PriceCreate


class CreateBalanceAssertionRequest(BaseModel):
    balance_assertion: BalanceAssertionCreate


class ImporterResource(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    plugin_name: str
    display_name: str
    config: dict[str, Any] = Field(default_factory=dict)
    importer_schema: dict[str, Any] = Field(default_factory=dict, alias="schema")


class ListImportersResponse(BaseModel):
    importers: list[ImporterResource]


class UpdateImporterData(BaseModel):
    name: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)


class UpdateImporterRequest(BaseModel):
    importer: UpdateImporterData
    update_mask: str | None = None


class ImportResponse(BaseModel):
    result: ImportResult
