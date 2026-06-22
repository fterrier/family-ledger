from __future__ import annotations

import json
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import date
from typing import Any, Literal, cast

from sqlalchemy import Select, select, text
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
    ListBalanceAssertionsResponse,
    ListCommoditiesResponse,
    ListPricesResponse,
    ListTransactionsResponse,
    MoneyValue,
    NormalizeTransactionResponse,
    PostingPayload,
    PriceCreate,
    PriceResource,
    TransactionCreate,
    TransactionData,
    TransactionNormalizeData,
    TransactionResource,
)
from family_ledger.models import (
    Account,
    BalanceAssertion,
    Commodity,
    Posting,
    Price,
    Transaction,
)
from family_ledger.services.errors import ConflictError, NotFoundError, ValidationError
from family_ledger.services.identifiers import generate_resource_name
from family_ledger.services.normalization import (
    normalize_and_validate_transaction_payload,
)
from family_ledger.services.transaction_balancing import (
    derive_normalize_issues,
    persisted_posting_weight,
)
from family_ledger.services.validation import (
    resolve_account,
    resolve_accounts,
    resource_name,
    validate_account_effective_dates,
    validate_symbols_exist,
)

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


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


def _run_list_page(
    session: Session, query: Select, *, page_size: int | None, page_token: str | None
) -> tuple[list[Any], str | None]:
    normalized = normalize_page_size(page_size)
    offset = decode_page_token(page_token)
    rows: list[Any] = list(
        session.scalars(paginate_query(query, offset=offset, page_size=normalized)).all()
    )
    next_token: str | None = None
    if len(rows) > normalized:
        rows = rows[:normalized]
        next_token = encode_page_token(offset + normalized)
    return rows, next_token


def serialize_account(account: Account) -> AccountResource:
    return AccountResource.model_validate(account)


def serialize_commodity(commodity: Commodity) -> CommodityResource:
    return CommodityResource.model_validate(commodity)


def serialize_transaction(transaction: Transaction) -> TransactionResource:
    postings = [
        PostingPayload(
            account=posting.account.name,
            account_name=posting.account.account_name,
            units=MoneyValue(amount=posting.units_amount, symbol=posting.units_symbol),
            narration=posting.narration,
            cost=None
            if posting.cost_per_unit is None
            else MoneyValue(amount=posting.cost_per_unit, symbol=cast(str, posting.cost_symbol)),
            price=None
            if posting.price_per_unit is None
            else MoneyValue(amount=posting.price_per_unit, symbol=cast(str, posting.price_symbol)),
            weight=persisted_posting_weight(posting),
            entity_metadata=posting.entity_metadata,
        )
        for posting in transaction.postings
    ]

    import_metadata = (
        ImportMetadata(source_native_ids=transaction.source_native_ids)
        if transaction.source_native_ids
        else None
    )

    return TransactionResource(
        name=transaction.name,
        transaction_date=transaction.transaction_date,
        payee=transaction.payee,
        narration=transaction.narration,
        tags=transaction.tags,
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


def normalize_transaction(
    session: Session,
    payload: TransactionNormalizeData,
) -> NormalizeTransactionResponse:
    normalized = normalize_and_validate_transaction_payload(session, payload)
    return NormalizeTransactionResponse(
        transaction=normalized,
        issues=derive_normalize_issues(normalized),
    )


def _reload_transaction_by_id(session: Session, transaction_id: int) -> Transaction:
    persisted = session.scalar(
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .where(Transaction.id == transaction_id)
    )
    assert persisted is not None
    return persisted


def _source_id_like_clause(session: Session, pattern: str):
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        return text(
            "EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_native_ids) AS v"
            " WHERE v LIKE :pat)"
        ).bindparams(pat=pattern)
    return text(
        "EXISTS (SELECT 1 FROM json_each(source_native_ids) WHERE value LIKE :pat)"
    ).bindparams(pat=pattern)


def _check_source_ids_available(
    session: Session, ids: list[str], exclude_name: str | None = None
) -> None:
    if not ids:
        return
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        rows = session.execute(
            text(
                "SELECT t.name, c.v"
                " FROM transactions t,"
                " jsonb_array_elements_text(t.source_native_ids) AS tv,"
                " jsonb_array_elements_text(CAST(:ids_json AS jsonb)) AS c(v)"
                " WHERE tv = c.v"
                " AND (:exclude IS NULL OR t.name != :exclude)"
                " LIMIT 1"
            ).bindparams(ids_json=json.dumps(ids), exclude=exclude_name)
        ).all()
    else:
        placeholders = ", ".join(f":id{i}" for i in range(len(ids)))
        params: dict[str, Any] = {f"id{i}": sid for i, sid in enumerate(ids)}
        params["exclude"] = exclude_name
        rows = session.execute(
            text(
                "SELECT t.name, j.value"
                f" FROM transactions t, json_each(t.source_native_ids) AS j"
                f" WHERE j.value IN ({placeholders})"
                " AND (:exclude IS NULL OR t.name != :exclude)"
                " LIMIT 1"
            ).bindparams(**params)
        ).all()
    if rows:
        owner, sid = rows[0]
        raise ConflictError(
            code="integrity_error",
            message=f"source_native_ids already contains: {sid!r} (on {owner})",
        )


def persist_transaction(
    session: Session,
    payload: TransactionData,
    transaction: Transaction | None = None,
    update_mask: str | None = None,
) -> Transaction:
    is_create = transaction is None
    mask = set(update_mask.split(",")) if (update_mask and not is_create) else None

    def _masked(field: str) -> bool:
        return mask is None or field in mask

    # Resolve accounts before session.add so the SELECT doesn't autoflush a
    # partially-initialised transaction and trigger constraint violations.
    account_map = resolve_accounts(session, payload.postings) if _masked("postings") else {}

    if _masked("import_metadata"):
        new_ids = payload.import_metadata.source_native_ids if payload.import_metadata else []
        exclude = None if is_create else transaction.name
        _check_source_ids_available(session, new_ids, exclude_name=exclude)

    if is_create:
        transaction = Transaction(name=generate_resource_name("transactions", "txn"))
        session.add(transaction)

    if _masked("transaction_date"):
        transaction.transaction_date = payload.transaction_date
    if _masked("payee"):
        transaction.payee = payload.payee
    if _masked("narration"):
        transaction.narration = payload.narration
    if _masked("entity_metadata"):
        transaction.entity_metadata = payload.entity_metadata
    if _masked("import_metadata"):
        transaction.source_native_ids = new_ids
    if _masked("tags"):
        transaction.tags = payload.tags
    if _masked("postings"):
        transaction.postings.clear()
        if transaction.id is not None:
            # Flush orphaned postings before reusing posting_order values on replacement updates.
            session.flush()

        for index, posting in enumerate(payload.postings, start=1):
            account = account_map[resource_name("accounts", posting.account)]
            transaction.postings.append(
                Posting(
                    account=account,
                    posting_order=index,
                    units_amount=posting.units.amount,
                    units_symbol=posting.units.symbol,
                    narration=posting.narration,
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


def get_transaction_row(session: Session, transaction: str) -> Transaction:
    resource = resource_name("transactions", transaction)
    transaction_row = session.scalar(
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .where(Transaction.name == resource)
    )
    if transaction_row is None:
        raise NotFoundError(code="transaction_not_found", message="Transaction not found")
    return transaction_row


def list_accounts_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListAccountsResponse:
    accounts, next_page_token = _run_list_page(
        session,
        select(Account).order_by(Account.account_name),
        page_size=page_size,
        page_token=page_token,
    )
    return ListAccountsResponse(
        accounts=[serialize_account(a) for a in accounts],
        next_page_token=next_page_token,
    )


def get_account_by_name(session: Session, account: str) -> AccountResource:
    resource = resource_name("accounts", account)
    account_row = session.scalar(select(Account).where(Account.name == resource))
    if account_row is None:
        raise NotFoundError(code="account_not_found", message="Account not found")
    return serialize_account(account_row)


def update_account(session: Session, account: str, payload: AccountCreate) -> AccountResource:
    resource = resource_name("accounts", account)
    account_row = session.scalar(select(Account).where(Account.name == resource))
    if account_row is None:
        raise NotFoundError(code="account_not_found", message="Account not found")
    validate_account_effective_dates(payload.effective_start_date, payload.effective_end_date)
    account_row.account_name = payload.account_name
    account_row.effective_start_date = payload.effective_start_date
    account_row.effective_end_date = payload.effective_end_date
    account_row.entity_metadata = payload.entity_metadata
    commit_or_raise(session)
    session.refresh(account_row)
    return serialize_account(account_row)


def create_account(session: Session, payload: AccountCreate) -> AccountResource:
    validate_account_effective_dates(payload.effective_start_date, payload.effective_end_date)
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
    commodities, next_page_token = _run_list_page(
        session,
        select(Commodity).order_by(Commodity.symbol),
        page_size=page_size,
        page_token=page_token,
    )
    return ListCommoditiesResponse(
        commodities=[serialize_commodity(c) for c in commodities],
        next_page_token=next_page_token,
    )


def get_commodity_by_name(session: Session, commodity: str) -> CommodityResource:
    resource = resource_name("commodities", commodity)
    commodity_row = session.scalar(select(Commodity).where(Commodity.name == resource))
    if commodity_row is None:
        raise NotFoundError(code="commodity_not_found", message="Commodity not found")
    return serialize_commodity(commodity_row)


def update_commodity(
    session: Session, commodity: str, payload: CommodityCreate
) -> CommodityResource:
    resource = resource_name("commodities", commodity)
    commodity_row = session.scalar(select(Commodity).where(Commodity.name == resource))
    if commodity_row is None:
        raise NotFoundError(code="commodity_not_found", message="Commodity not found")
    commodity_row.symbol = payload.symbol
    commodity_row.ticker = payload.ticker
    commit_or_raise(session)
    session.refresh(commodity_row)
    return serialize_commodity(commodity_row)


def delete_commodity(session: Session, commodity: str) -> None:
    resource = resource_name("commodities", commodity)
    commodity_row = session.scalar(select(Commodity).where(Commodity.name == resource))
    if commodity_row is None:
        raise NotFoundError(code="commodity_not_found", message="Commodity not found")
    session.delete(commodity_row)
    commit_or_raise(session)


def create_commodity(session: Session, payload: CommodityCreate) -> CommodityResource:
    commodity = Commodity(
        name=generate_resource_name("commodities", "cmd"),
        symbol=payload.symbol,
        ticker=payload.ticker,
        entity_metadata=payload.entity_metadata,
    )
    session.add(commodity)
    commit_or_raise(session)
    session.refresh(commodity)
    return serialize_commodity(commodity)


def create_transaction(
    session: Session,
    payload: TransactionCreate | TransactionNormalizeData,
) -> TransactionResource:
    normalized = normalize_and_validate_transaction_payload(session, payload)
    transaction = persist_transaction(session, normalized)
    commit_or_raise(session)
    return serialize_transaction(_reload_transaction_by_id(session, transaction.id))


def update_transaction(
    session: Session,
    transaction: str,
    payload: TransactionCreate | TransactionNormalizeData,
    update_mask: str | None = None,
) -> TransactionResource:
    transaction_row = get_transaction_row(session, transaction)
    normalized = normalize_and_validate_transaction_payload(session, payload)
    persist_transaction(session, normalized, transaction=transaction_row, update_mask=update_mask)
    commit_or_raise(session)
    return serialize_transaction(_reload_transaction_by_id(session, transaction_row.id))


def list_transactions_page(
    session: Session,
    *,
    page_size: int | None,
    page_token: str | None,
    from_date: date | None,
    to_date: date | None,
    account: str | None,
    order: Literal["asc", "desc"] = "asc",
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
    if account is not None:
        account_name = resource_name("accounts", account)
        matching_ids = (
            select(Transaction.id)
            .join(Transaction.postings)
            .join(Posting.account)
            .where(Account.name == account_name)
        )
        query = query.where(Transaction.id.in_(matching_ids))
    if order == "desc":
        query = query.order_by(Transaction.transaction_date.desc(), Transaction.name.desc())
    else:
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
    transaction_row = get_transaction_row(session, transaction)
    return serialize_transaction(transaction_row)


def find_transactions_by_source_id_pattern(
    session: Session,
    pattern: str,
    from_date: date | None = None,
    to_date: date | None = None,
) -> list[TransactionResource]:
    q = (
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .where(_source_id_like_clause(session, pattern))
    )
    if from_date is not None:
        q = q.where(Transaction.transaction_date >= from_date)
    if to_date is not None:
        q = q.where(Transaction.transaction_date <= to_date)
    return [serialize_transaction(row) for row in session.scalars(q).all()]


def delete_transaction(session: Session, transaction: str) -> None:
    transaction_row = get_transaction_row(session, transaction)
    session.delete(transaction_row)
    commit_or_raise(session)


def _posting_key(p: Posting) -> tuple:
    return (
        p.account_id,
        p.units_amount,
        p.units_symbol,
        p.cost_per_unit,
        p.cost_symbol,
        p.price_per_unit,
        p.price_symbol,
    )


def merge_transactions(
    session: Session, primary_name: str, secondary_name: str
) -> TransactionResource:
    primary = get_transaction_row(session, primary_name)
    secondary = get_transaction_row(session, secondary_name)

    merged_payee = primary.payee or secondary.payee
    merged_narration = primary.narration or secondary.narration

    # narration_overrides avoids mutating session-tracked Posting rows (SQLAlchemy persists them)
    narration_overrides: dict[tuple, str] = {}
    primary_key: dict[tuple, Posting] = {}
    result_postings: list[Posting] = []
    for pp in primary.postings:
        primary_key[_posting_key(pp)] = pp
        result_postings.append(pp)
    for sp in secondary.postings:
        key = _posting_key(sp)
        if key in primary_key:
            if not primary_key[key].narration and sp.narration:
                narration_overrides[key] = sp.narration
        else:
            result_postings.append(sp)

    merged_ids = list(dict.fromkeys(primary.source_native_ids + secondary.source_native_ids))

    merged = Transaction(
        name=generate_resource_name("transactions", "txn"),
        transaction_date=primary.transaction_date,
        payee=merged_payee,
        narration=merged_narration,
        tags=list(dict.fromkeys(primary.tags + secondary.tags)),
        entity_metadata=primary.entity_metadata,
        source_native_ids=merged_ids,
    )
    session.add(merged)
    session.flush()

    for idx, p in enumerate(result_postings, start=1):
        session.add(
            Posting(
                transaction_id=merged.id,
                account_id=p.account_id,
                posting_order=idx,
                units_amount=p.units_amount,
                units_symbol=p.units_symbol,
                narration=narration_overrides.get(_posting_key(p), p.narration),
                cost_per_unit=p.cost_per_unit,
                cost_symbol=p.cost_symbol,
                price_per_unit=p.price_per_unit,
                price_symbol=p.price_symbol,
                entity_metadata=p.entity_metadata,
            )
        )

    commit_or_raise(session)
    return serialize_transaction(_reload_transaction_by_id(session, merged.id))


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


def update_price(session: Session, price: str, payload: PriceCreate) -> PriceResource:
    resource = resource_name("prices", price)
    price_row = session.scalar(select(Price).where(Price.name == resource))
    if price_row is None:
        raise NotFoundError(code="price_not_found", message="Price not found")
    validate_symbols_exist(session, {payload.base_symbol, payload.quote.symbol})
    price_row.price_date = payload.price_date
    price_row.base_symbol = payload.base_symbol
    price_row.quote_symbol = payload.quote.symbol
    price_row.price_per_unit = payload.quote.amount
    commit_or_raise(session)
    session.refresh(price_row)
    return serialize_price(price_row)


def list_prices_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListPricesResponse:
    prices, next_page_token = _run_list_page(
        session,
        select(Price).order_by(Price.price_date, Price.name),
        page_size=page_size,
        page_token=page_token,
    )
    return ListPricesResponse(
        prices=[serialize_price(p) for p in prices],
        next_page_token=next_page_token,
    )


def list_balance_assertions_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListBalanceAssertionsResponse:
    assertions, next_page_token = _run_list_page(
        session,
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .order_by(BalanceAssertion.assertion_date, BalanceAssertion.name),
        page_size=page_size,
        page_token=page_token,
    )
    return ListBalanceAssertionsResponse(
        balance_assertions=[serialize_balance_assertion(a) for a in assertions],
        next_page_token=next_page_token,
    )


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


def update_balance_assertion(
    session: Session, balance_assertion: str, payload: BalanceAssertionCreate
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
    account = resolve_account(session, payload.account)
    validate_symbols_exist(session, {payload.amount.symbol})
    assertion.assertion_date = payload.assertion_date
    assertion.account = account
    assertion.amount = payload.amount.amount
    assertion.symbol = payload.amount.symbol
    assertion.entity_metadata = payload.entity_metadata
    commit_or_raise(session)
    session.refresh(assertion)
    return serialize_balance_assertion(assertion)


def delete_balance_assertion(session: Session, balance_assertion: str) -> None:
    resource = resource_name("balanceAssertions", balance_assertion)
    assertion = session.scalar(select(BalanceAssertion).where(BalanceAssertion.name == resource))
    if assertion is None:
        raise NotFoundError(
            code="balance_assertion_not_found", message="Balance assertion not found"
        )
    session.delete(assertion)
    commit_or_raise(session)


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
