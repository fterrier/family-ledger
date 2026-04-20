from __future__ import annotations

import hashlib
import json
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import date
from typing import cast

from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from family_ledger.api.schemas import (
    AccountCreate,
    AccountResource,
    BalanceAssertionCreate,
    BalanceAssertionResource,
    CommodityCreate,
    CommodityResource,
    ImportMetadata,
    ListAccountsResponse,
    ListCommoditiesResponse,
    ListTransactionsResponse,
    MoneyValue,
    PostingPayload,
    PriceCreate,
    PriceResource,
    TransactionCreate,
    TransactionData,
    TransactionResource,
)
from family_ledger.models import Account, BalanceAssertion, Commodity, Posting, Price, Transaction
from family_ledger.services.errors import ConflictError, NotFoundError, ValidationError
from family_ledger.services.identifiers import generate_resource_name

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


def resource_name(prefix: str, value: str) -> str:
    return value if "/" in value else f"{prefix}/{value}"


def normalize_page_size(page_size: int | None) -> int:
    if page_size is None:
        return DEFAULT_PAGE_SIZE
    if page_size <= 0:
        raise ValidationError(code="invalid_page_size", message="page_size must be positive")
    return min(page_size, MAX_PAGE_SIZE)


def decode_page_token(page_token: str | None) -> int:
    if not page_token:
        return 0
    try:
        decoded = urlsafe_b64decode(page_token.encode()).decode()
        offset = int(decoded)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValidationError(code="invalid_page_token", message="Invalid page_token") from exc
    if offset < 0:
        raise ValidationError(code="invalid_page_token", message="Invalid page_token")
    return offset


def encode_page_token(offset: int) -> str:
    return urlsafe_b64encode(str(offset).encode()).decode()


def paginate_query(query: Select, *, offset: int, page_size: int):
    return query.offset(offset).limit(page_size + 1)


def transaction_fingerprint_content(payload: TransactionData) -> dict[str, object]:
    """Return the canonical content used for transaction dedupe fingerprints.

    The fingerprint intentionally tracks current transaction content rather than
    stable source identity. It is recomputed on transaction writes and excludes
    source-native IDs and free-form metadata.
    """

    return {
        "transaction_date": payload.transaction_date.isoformat(),
        "payee": payload.payee,
        "narration": payload.narration,
        "postings": [
            {
                "account": posting.account,
                "units": {"amount": str(posting.units.amount), "symbol": posting.units.symbol},
                "cost": None
                if posting.cost is None
                else {"amount": str(posting.cost.amount), "symbol": posting.cost.symbol},
                "price": None
                if posting.price is None
                else {"amount": str(posting.price.amount), "symbol": posting.price.symbol},
            }
            for posting in payload.postings
        ],
    }


def hash_transaction_payload(payload: TransactionData) -> str:
    content = transaction_fingerprint_content(payload)
    digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode())
    return f"sha256:{digest.hexdigest()}"


def serialize_account(account: Account) -> AccountResource:
    return AccountResource.model_validate(account)


def serialize_commodity(commodity: Commodity) -> CommodityResource:
    return CommodityResource.model_validate(commodity)


def serialize_transaction(transaction: Transaction) -> TransactionResource:
    postings = [
        PostingPayload(
            account=posting.account.name,
            units=MoneyValue(amount=posting.units_amount, symbol=posting.units_symbol),
            cost=None
            if posting.cost_per_unit is None
            else MoneyValue(amount=posting.cost_per_unit, symbol=cast(str, posting.cost_symbol)),
            price=None
            if posting.price_per_unit is None
            else MoneyValue(amount=posting.price_per_unit, symbol=cast(str, posting.price_symbol)),
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


def serialize_price(price: Price) -> PriceResource:
    return PriceResource(
        name=price.name,
        price_date=price.price_date,
        base_symbol=price.base_symbol,
        quote=MoneyValue(amount=price.price_per_unit, symbol=price.quote_symbol),
        entity_metadata=price.entity_metadata,
    )


def serialize_balance_assertion(assertion: BalanceAssertion) -> BalanceAssertionResource:
    return BalanceAssertionResource(
        name=assertion.name,
        assertion_date=assertion.assertion_date,
        account=assertion.account.name,
        amount=MoneyValue(amount=assertion.amount, symbol=assertion.symbol),
        entity_metadata=assertion.entity_metadata,
    )


def resolve_accounts(session: Session, postings: list[PostingPayload]) -> dict[str, Account]:
    account_names = {resource_name("accounts", posting.account) for posting in postings}
    accounts = session.scalars(select(Account).where(Account.name.in_(account_names))).all()
    by_name = {account.name: account for account in accounts}
    missing = sorted(account_names - by_name.keys())
    if missing:
        raise ValidationError(
            code="account_not_found", message=f"Accounts not found: {', '.join(missing)}"
        )
    return by_name


def resolve_account(session: Session, account_name: str) -> Account:
    resolved_name = resource_name("accounts", account_name)
    account = session.scalar(select(Account).where(Account.name == resolved_name))
    if account is None:
        raise ValidationError(
            code="account_not_found", message=f"Account not found: {resolved_name}"
        )
    return account


def validate_account_dates(transaction_date: date, accounts: dict[str, Account]) -> None:
    invalid = []
    for account in accounts.values():
        if transaction_date < account.effective_start_date:
            invalid.append(account.name)
        elif (
            account.effective_end_date is not None and transaction_date > account.effective_end_date
        ):
            invalid.append(account.name)
    if invalid:
        raise ValidationError(
            code="account_not_effective",
            message=f"Accounts not effective on transaction date: {', '.join(sorted(invalid))}",
        )


def validate_symbols_exist(session: Session, symbols: set[str]) -> None:
    existing = session.scalars(select(Commodity.symbol).where(Commodity.symbol.in_(symbols))).all()
    missing = sorted(symbols - set(existing))
    if missing:
        raise ValidationError(
            code="commodity_not_found",
            message=f"Commodities not found: {', '.join(missing)}",
        )


def validate_transaction_symbols(session: Session, payload: TransactionData) -> None:
    symbols = set()
    for posting in payload.postings:
        symbols.add(posting.units.symbol)
        if posting.cost is not None:
            symbols.add(posting.cost.symbol)
        if posting.price is not None:
            symbols.add(posting.price.symbol)
    validate_symbols_exist(session, symbols)


def persist_transaction(
    session: Session,
    payload: TransactionData,
    transaction: Transaction | None = None,
) -> Transaction:
    account_map = resolve_accounts(session, payload.postings)
    validate_account_dates(payload.transaction_date, account_map)
    validate_transaction_symbols(session, payload)

    if transaction is None:
        transaction = Transaction(name=generate_resource_name("transactions", "txn"))
        session.add(transaction)

    transaction.transaction_date = payload.transaction_date
    transaction.payee = payload.payee
    transaction.narration = payload.narration
    transaction.entity_metadata = payload.entity_metadata
    transaction.source_native_id = (
        payload.import_metadata.source_native_id if payload.import_metadata else None
    )
    transaction.fingerprint = hash_transaction_payload(payload)
    transaction.postings.clear()

    for index, posting in enumerate(payload.postings, start=1):
        account = account_map[resource_name("accounts", posting.account)]
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


def commit_or_raise(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ConflictError(code="integrity_error", message=str(exc.orig)) from exc


def list_accounts_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListAccountsResponse:
    normalized_page_size = normalize_page_size(page_size)
    offset = decode_page_token(page_token)
    accounts = session.scalars(
        paginate_query(
            select(Account).order_by(Account.account_name),
            offset=offset,
            page_size=normalized_page_size,
        )
    ).all()
    next_page_token = None
    if len(accounts) > normalized_page_size:
        accounts = accounts[:normalized_page_size]
        next_page_token = encode_page_token(offset + normalized_page_size)
    return ListAccountsResponse(
        accounts=[serialize_account(account) for account in accounts],
        next_page_token=next_page_token,
    )


def get_account_by_name(session: Session, account: str) -> AccountResource:
    resource = resource_name("accounts", account)
    account_row = session.scalar(select(Account).where(Account.name == resource))
    if account_row is None:
        raise NotFoundError(code="account_not_found", message="Account not found")
    return serialize_account(account_row)


def create_account(session: Session, payload: AccountCreate) -> AccountResource:
    account = Account(
        name=generate_resource_name("accounts", "acc"),
        account_name=payload.account_name,
        effective_start_date=payload.effective_start_date,
        effective_end_date=payload.effective_end_date,
        entity_metadata=payload.entity_metadata,
    )
    session.add(account)
    commit_or_raise(session)
    session.refresh(account)
    return serialize_account(account)


def list_commodities_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListCommoditiesResponse:
    normalized_page_size = normalize_page_size(page_size)
    offset = decode_page_token(page_token)
    commodities = session.scalars(
        paginate_query(
            select(Commodity).order_by(Commodity.symbol),
            offset=offset,
            page_size=normalized_page_size,
        )
    ).all()
    next_page_token = None
    if len(commodities) > normalized_page_size:
        commodities = commodities[:normalized_page_size]
        next_page_token = encode_page_token(offset + normalized_page_size)
    return ListCommoditiesResponse(
        commodities=[serialize_commodity(commodity) for commodity in commodities],
        next_page_token=next_page_token,
    )


def get_commodity_by_name(session: Session, commodity: str) -> CommodityResource:
    resource = resource_name("commodities", commodity)
    commodity_row = session.scalar(select(Commodity).where(Commodity.name == resource))
    if commodity_row is None:
        raise NotFoundError(code="commodity_not_found", message="Commodity not found")
    return serialize_commodity(commodity_row)


def create_commodity(session: Session, payload: CommodityCreate) -> CommodityResource:
    commodity = Commodity(
        name=generate_resource_name("commodities", "cmd"),
        symbol=payload.symbol,
        entity_metadata=payload.entity_metadata,
    )
    session.add(commodity)
    commit_or_raise(session)
    session.refresh(commodity)
    return serialize_commodity(commodity)


def create_transaction(session: Session, payload: TransactionCreate) -> TransactionResource:
    transaction = persist_transaction(session, payload)
    commit_or_raise(session)
    session.refresh(transaction)
    persisted = session.scalar(
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .where(Transaction.id == transaction.id)
    )
    assert persisted is not None
    return serialize_transaction(persisted)


def list_transactions_page(
    session: Session,
    *,
    page_size: int | None,
    page_token: str | None,
    from_date: date | None,
    to_date: date | None,
    account: str | None,
    fingerprint: str | None,
) -> ListTransactionsResponse:
    normalized_page_size = normalize_page_size(page_size)
    offset = decode_page_token(page_token)
    query = select(Transaction).options(
        selectinload(Transaction.postings).selectinload(Posting.account)
    )
    if from_date is not None:
        query = query.where(Transaction.transaction_date >= from_date)
    if to_date is not None:
        query = query.where(Transaction.transaction_date <= to_date)
    if fingerprint is not None:
        query = query.where(Transaction.fingerprint == fingerprint)
    if account is not None:
        account_name = resource_name("accounts", account)
        query = (
            query.join(Transaction.postings)
            .join(Posting.account)
            .where(Account.name == account_name)
            .distinct()
        )
    query = query.order_by(Transaction.transaction_date, Transaction.name)
    transactions = session.scalars(
        paginate_query(query, offset=offset, page_size=normalized_page_size)
    ).all()
    next_page_token = None
    if len(transactions) > normalized_page_size:
        transactions = transactions[:normalized_page_size]
        next_page_token = encode_page_token(offset + normalized_page_size)
    return ListTransactionsResponse(
        transactions=[serialize_transaction(transaction) for transaction in transactions],
        next_page_token=next_page_token,
    )


def get_transaction_by_name(session: Session, transaction: str) -> TransactionResource:
    resource = resource_name("transactions", transaction)
    transaction_row = session.scalar(
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .where(Transaction.name == resource)
    )
    if transaction_row is None:
        raise NotFoundError(code="transaction_not_found", message="Transaction not found")
    return serialize_transaction(transaction_row)


def create_price(session: Session, payload: PriceCreate) -> PriceResource:
    validate_symbols_exist(session, {payload.base_symbol, payload.quote.symbol})
    price = Price(
        name=generate_resource_name("prices", "prc"),
        price_date=payload.price_date,
        base_symbol=payload.base_symbol,
        quote_symbol=payload.quote.symbol,
        price_per_unit=payload.quote.amount,
        entity_metadata=payload.entity_metadata,
    )
    session.add(price)
    commit_or_raise(session)
    session.refresh(price)
    return serialize_price(price)


def get_price_by_name(session: Session, price: str) -> PriceResource:
    resource = resource_name("prices", price)
    price_row = session.scalar(select(Price).where(Price.name == resource))
    if price_row is None:
        raise NotFoundError(code="price_not_found", message="Price not found")
    return serialize_price(price_row)


def create_balance_assertion(
    session: Session, payload: BalanceAssertionCreate
) -> BalanceAssertionResource:
    account = resolve_account(session, payload.account)
    validate_symbols_exist(session, {payload.amount.symbol})
    assertion = BalanceAssertion(
        name=generate_resource_name("balanceAssertions", "bal"),
        assertion_date=payload.assertion_date,
        account=account,
        amount=payload.amount.amount,
        symbol=payload.amount.symbol,
        entity_metadata=payload.entity_metadata,
    )
    session.add(assertion)
    commit_or_raise(session)
    session.refresh(assertion)
    persisted = session.scalar(
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .where(BalanceAssertion.id == assertion.id)
    )
    assert persisted is not None
    return serialize_balance_assertion(persisted)


def get_balance_assertion_by_name(
    session: Session, balance_assertion: str
) -> BalanceAssertionResource:
    resource = resource_name("balanceAssertions", balance_assertion)
    assertion = session.scalar(
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .where(BalanceAssertion.name == resource)
    )
    if assertion is None:
        raise NotFoundError(
            code="balance_assertion_not_found", message="Balance assertion not found"
        )
    return serialize_balance_assertion(assertion)
