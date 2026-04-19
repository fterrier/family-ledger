from __future__ import annotations

import hashlib
import json
from datetime import date
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from family_ledger.db import get_db_session
from family_ledger.models import Account, Commodity, Posting, Transaction

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db_session)]


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


def _resource_name(prefix: str, value: str) -> str:
    return value if "/" in value else f"{prefix}/{value}"


def _hash_transaction_payload(payload: TransactionResource) -> str:
    content = {
        "transaction_date": payload.transaction_date.isoformat(),
        "payee": payload.payee,
        "narration": payload.narration,
        "postings": [
            {
                "account": posting.account,
                "units": {
                    "amount": str(posting.units.amount),
                    "symbol": posting.units.symbol,
                },
                "cost": None
                if posting.cost is None
                else {
                    "amount": str(posting.cost.amount),
                    "symbol": posting.cost.symbol,
                },
                "price": None
                if posting.price is None
                else {
                    "amount": str(posting.price.amount),
                    "symbol": posting.price.symbol,
                },
            }
            for posting in payload.postings
        ],
    }
    digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode())
    return f"sha256:{digest.hexdigest()}"


def _serialize_transaction(transaction: Transaction) -> TransactionResource:
    postings = [
        PostingPayload(
            account=posting.account.name,
            units=MoneyValue(amount=posting.units_amount, symbol=posting.units_symbol),
            cost=None
            if posting.cost_per_unit is None
            else MoneyValue(amount=posting.cost_per_unit, symbol=posting.cost_symbol),
            price=None
            if posting.price_per_unit is None
            else MoneyValue(amount=posting.price_per_unit, symbol=posting.price_symbol),
            entity_metadata=posting.entity_metadata,
        )
        for posting in transaction.postings
    ]

    import_metadata = None
    if transaction.source_native_id is not None or transaction.fingerprint is not None:
        import_metadata = ImportMetadata(
            source_native_id=transaction.source_native_id,
            fingerprint=transaction.fingerprint,
        )

    return TransactionResource(
        name=transaction.name,
        transaction_date=transaction.transaction_date,
        payee=transaction.payee,
        narration=transaction.narration,
        entity_metadata=transaction.entity_metadata,
        import_metadata=import_metadata,
        postings=postings,
    )


def _resolve_accounts(session: Session, postings: list[PostingPayload]) -> dict[str, Account]:
    account_names = {_resource_name("accounts", posting.account) for posting in postings}
    accounts = session.scalars(select(Account).where(Account.name.in_(account_names))).all()
    by_name = {account.name: account for account in accounts}

    missing = sorted(account_names - by_name.keys())
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "account_not_found",
                "message": f"Accounts not found: {', '.join(missing)}",
            },
        )

    return by_name


def _validate_account_dates(transaction_date: date, accounts: dict[str, Account]) -> None:
    invalid = []
    for account in accounts.values():
        if transaction_date < account.effective_start_date:
            invalid.append(account.name)
        elif (
            account.effective_end_date is not None and transaction_date > account.effective_end_date
        ):
            invalid.append(account.name)

    if invalid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "account_not_effective",
                "message": (
                    f"Accounts not effective on transaction date: {', '.join(sorted(invalid))}"
                ),
            },
        )


def _validate_commodity_symbols(session: Session, payload: TransactionResource) -> None:
    symbols = set()
    for posting in payload.postings:
        symbols.add(posting.units.symbol)
        if posting.cost is not None:
            symbols.add(posting.cost.symbol)
        if posting.price is not None:
            symbols.add(posting.price.symbol)

    existing = session.scalars(select(Commodity.symbol).where(Commodity.symbol.in_(symbols))).all()
    missing = sorted(symbols - set(existing))
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "commodity_not_found",
                "message": f"Commodities not found: {', '.join(missing)}",
            },
        )


def _persist_transaction(
    session: Session, payload: TransactionResource, transaction: Transaction | None = None
) -> Transaction:
    account_map = _resolve_accounts(session, payload.postings)
    _validate_account_dates(payload.transaction_date, account_map)
    _validate_commodity_symbols(session, payload)

    if transaction is None:
        transaction = Transaction(name=payload.name)
        session.add(transaction)

    transaction.transaction_date = payload.transaction_date
    transaction.payee = payload.payee
    transaction.narration = payload.narration
    transaction.entity_metadata = payload.entity_metadata
    transaction.source_native_id = (
        payload.import_metadata.source_native_id if payload.import_metadata else None
    )
    transaction.fingerprint = _hash_transaction_payload(payload)
    transaction.postings.clear()

    for index, posting in enumerate(payload.postings, start=1):
        account = account_map[_resource_name("accounts", posting.account)]
        transaction.postings.append(
            Posting(
                account=account,
                posting_order=index,
                units_amount=posting.units.amount,
                units_symbol=posting.units.symbol,
                cost_per_unit=None if posting.cost is None else posting.cost.amount,
                cost_symbol=None if posting.cost is None else posting.cost.symbol,
                price_per_unit=None if posting.price is None else posting.price.amount,
                price_symbol=None if posting.price is None else posting.price.symbol,
                entity_metadata=posting.entity_metadata,
            )
        )

    return transaction


def _commit_or_raise(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "integrity_error", "message": str(exc.orig)},
        ) from exc


@router.get("/accounts", response_model=ListAccountsResponse)
def list_accounts(session: DbSession) -> ListAccountsResponse:
    accounts = session.scalars(select(Account).order_by(Account.ledger_name)).all()
    return ListAccountsResponse(
        accounts=[AccountResource.model_validate(account) for account in accounts]
    )


@router.post(
    "/accounts",
    response_model=AccountResource,
    status_code=status.HTTP_201_CREATED,
)
def create_account(request: CreateAccountRequest, session: DbSession) -> AccountResource:
    account = Account(
        name=request.account.name,
        ledger_name=request.account.ledger_name,
        effective_start_date=request.account.effective_start_date,
        effective_end_date=request.account.effective_end_date,
        entity_metadata=request.account.entity_metadata,
    )
    session.add(account)
    _commit_or_raise(session)
    session.refresh(account)
    return AccountResource.model_validate(account)


@router.get("/accounts/{account:path}", response_model=AccountResource)
def get_account(account: str, session: DbSession) -> AccountResource:
    resource_name = _resource_name("accounts", account)
    account_row = session.scalar(select(Account).where(Account.name == resource_name))
    if account_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found",
        )
    return AccountResource.model_validate(account_row)


@router.get("/commodities", response_model=ListCommoditiesResponse)
def list_commodities(session: DbSession) -> ListCommoditiesResponse:
    commodities = session.scalars(select(Commodity).order_by(Commodity.symbol)).all()
    return ListCommoditiesResponse(
        commodities=[CommodityResource.model_validate(commodity) for commodity in commodities]
    )


@router.post(
    "/commodities",
    response_model=CommodityResource,
    status_code=status.HTTP_201_CREATED,
)
def create_commodity(request: CreateCommodityRequest, session: DbSession) -> CommodityResource:
    commodity = Commodity(
        name=request.commodity.name,
        symbol=request.commodity.symbol,
        entity_metadata=request.commodity.entity_metadata,
    )
    session.add(commodity)
    _commit_or_raise(session)
    session.refresh(commodity)
    return CommodityResource.model_validate(commodity)


@router.get("/commodities/{commodity:path}", response_model=CommodityResource)
def get_commodity(commodity: str, session: DbSession) -> CommodityResource:
    resource_name = _resource_name("commodities", commodity)
    commodity_row = session.scalar(select(Commodity).where(Commodity.name == resource_name))
    if commodity_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Commodity not found",
        )
    return CommodityResource.model_validate(commodity_row)


@router.post(
    "/transactions", response_model=TransactionResource, status_code=status.HTTP_201_CREATED
)
def create_transaction(
    request: CreateTransactionRequest, session: DbSession
) -> TransactionResource:
    transaction = _persist_transaction(session, request.transaction)
    _commit_or_raise(session)
    session.refresh(transaction)
    transaction = session.scalar(
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .where(Transaction.id == transaction.id)
    )
    return _serialize_transaction(transaction)


@router.get("/transactions/{transaction:path}", response_model=TransactionResource)
def get_transaction(transaction: str, session: DbSession) -> TransactionResource:
    resource_name = _resource_name("transactions", transaction)
    transaction_row = session.scalar(
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .where(Transaction.name == resource_name)
    )
    if transaction_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Transaction not found",
        )
    return _serialize_transaction(transaction_row)
