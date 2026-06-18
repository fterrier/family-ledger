from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from family_ledger.importers.result import EntityCounts as EntityCounts  # noqa: F401
from family_ledger.importers.result import EntityErrors as EntityErrors  # noqa: F401
from family_ledger.importers.result import ImportResult as ImportResult  # noqa: F401

_TAG_RE = re.compile(r"^\S+$")


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
    account_name: str | None = None  # Beancount path in responses; ignored on input
    units: MoneyValue
    narration: str | None = None
    cost: MoneyValue | None = None
    price: MoneyValue | None = None
    weight: MoneyValue | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class ImportMetadata(BaseModel):
    source_native_id: str | None = None


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
    ticker: str | None = None
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


class UpdatePriceRequest(BaseModel):
    price: PriceCreate
    update_mask: str | None = None


class ListPricesResponse(BaseModel):
    prices: list[PriceResource]
    next_page_token: str | None = None


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


class ListBalanceAssertionsResponse(BaseModel):
    balance_assertions: list[BalanceAssertionResource]
    next_page_token: str | None = None


class AttachmentData(BaseModel):
    account: str
    attachment_date: date
    original_filename: str
    media_type: str | None = None
    status: str
    document_url: str | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class AttachmentResource(AttachmentData):
    model_config = ConfigDict(from_attributes=True)

    name: str
    storage_metadata: dict[str, Any] = Field(default_factory=dict)


class ListAttachmentsResponse(BaseModel):
    attachments: list[AttachmentResource]
    next_page_token: str | None = None


class AttachmentCreate(BaseModel):
    account: str
    attachment_date: date
    original_filename: str
    media_type: str | None = None
    document_url: str | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class CreateAttachmentRequest(BaseModel):
    attachment: AttachmentCreate


class UpdateAttachmentRequest(BaseModel):
    attachment: AttachmentCreate
    update_mask: str | None = None


class TransactionData(BaseModel):
    transaction_date: date
    payee: str | None = None
    narration: str | None = None
    tags: list[str] = Field(default_factory=list)
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
    narration: str | None = None
    cost: MoneyValue | None = None
    price: MoneyValue | NormalizePriceValue | None = None
    entity_metadata: dict[str, Any] = Field(default_factory=dict)


class TransactionNormalizeData(BaseModel):
    transaction_date: date
    payee: str | None = None
    narration: str | None = None
    tags: list[str] = Field(default_factory=list)
    entity_metadata: dict[str, Any] = Field(default_factory=dict)
    import_metadata: ImportMetadata | None = None
    postings: list[PostingNormalizePayload]

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, v: list[str]) -> list[str]:
        for tag in v:
            if not _TAG_RE.match(tag):
                raise ValueError(f"tag '{tag}' must not be empty or contain whitespace")
        return v


class NormalizeTransactionRequest(BaseModel):
    transaction: TransactionNormalizeData


class NormalizeTransactionResponse(BaseModel):
    transaction: TransactionCreate
    issues: list[DoctorIssue] = Field(default_factory=list)


class CreateAccountRequest(BaseModel):
    account: AccountCreate


class UpdateAccountRequest(BaseModel):
    account: AccountCreate
    update_mask: str | None = None


class ListAccountsResponse(BaseModel):
    accounts: list[AccountResource]
    next_page_token: str | None = None


class CreateCommodityRequest(BaseModel):
    commodity: CommodityCreate


class UpdateCommodityRequest(BaseModel):
    commodity: CommodityCreate
    update_mask: str | None = None


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
    target: str | None = None
    code: str
    severity: str
    message: str
    details: dict[str, str] = Field(default_factory=dict)
    target_summary: dict[str, str] = Field(default_factory=dict)


class DoctorLedgerRequest(BaseModel):
    pass


class DoctorLedgerResponse(BaseModel):
    issues: list[DoctorIssue] = Field(default_factory=list)


class CreatePriceRequest(BaseModel):
    price: PriceCreate


class CreateBalanceAssertionRequest(BaseModel):
    balance_assertion: BalanceAssertionCreate


class UpdateBalanceAssertionRequest(BaseModel):
    balance_assertion: BalanceAssertionCreate
    update_mask: str | None = None


class PadEntry(BaseModel):
    balance_assertion: str
    assertion_date: date
    units: MoneyValue


class PadResponse(BaseModel):
    account: str
    pad_date: date
    entries: list[PadEntry]


class ImporterResource(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    plugin_name: str
    display_name: str
    config: dict[str, Any] = Field(default_factory=dict)
    importer_schema: dict[str, Any] = Field(default_factory=dict, alias="schema")
    file_descriptors: list[dict[str, Any]] = Field(default_factory=list)


class ListImportersResponse(BaseModel):
    importers: list[ImporterResource]


class UpdateImporterData(BaseModel):
    config: dict[str, Any] = Field(default_factory=dict)


class UpdateImporterRequest(BaseModel):
    importer: UpdateImporterData
    update_mask: str | None = None


class ImportResponse(BaseModel):
    result: ImportResult
