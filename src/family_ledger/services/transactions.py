from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from typing import Any, Literal, cast

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, selectinload

from family_ledger.api.schemas import (
    ImportMetadata,
    ListTransactionsResponse,
    MoneyValue,
    NormalizeTransactionResponse,
    PostingNormalizePayload,
    PostingPayload,
    SplitTransactionRequest,
    TransactionCreate,
    TransactionNormalizeData,
    TransactionResource,
    UnsplitTransactionRequest,
)
from family_ledger.models import Account, Posting, Transaction, current_update_time
from family_ledger.services.account_matching import account_subtree_clause
from family_ledger.services.errors import (
    ConflictError,
    NotFoundError,
    ValidationError,
    commit_or_raise,
)
from family_ledger.services.identifiers import generate_resource_name
from family_ledger.services.normalization import normalize_and_validate_transaction_payload
from family_ledger.services.pagination import run_list_page
from family_ledger.services.prices import PriceLookup
from family_ledger.services.transaction_balancing import (
    compute_full_balance_residuals_for_payload,
    decimal_to_string,
    persisted_posting_weight,
)
from family_ledger.services.validation import resource_name


def _converted_weight(
    weight: MoneyValue, on: date, price_lookup: PriceLookup | None
) -> MoneyValue | None:
    """[weight] (a posting's cost/price-adjusted value, or raw units when
    there's no cost/price — see persisted_posting_weight, which the caller
    already computed once) valued in the lookup's target currency at the
    transaction date. The weight is always the conversion basis, never the
    posting's raw units directly — even when those units already happen to
    be in the target currency: e.g. 100 CHF bought at cost {1.2 USD} was
    really 120 USD spent, and its current CHF value is that 120 USD
    re-priced at today's rate, not a trivial 100 CHF (matches bean-query's
    convert_position, which always reduces a position to its weight before
    any currency conversion). None when no lookup was requested, or no
    price path exists for the weight's currency."""
    if price_lookup is None:
        return None
    # DB numerics carry their full storage scale (20 decimals of trailing
    # zeros); serialize like the query endpoint does.
    if weight.symbol == price_lookup.target:
        return MoneyValue(amount=Decimal(decimal_to_string(weight.amount)), symbol=weight.symbol)
    rate = price_lookup.rate(weight.symbol, on)
    if rate is None:
        return None
    return MoneyValue(
        amount=Decimal(decimal_to_string(weight.amount * rate)),
        symbol=price_lookup.target,
    )


def serialize_transaction(
    transaction: Transaction, *, price_lookup: PriceLookup | None = None
) -> TransactionResource:
    postings = []
    for posting in transaction.postings:
        weight = persisted_posting_weight(posting)
        postings.append(
            PostingPayload(
                account=posting.account.name if posting.account else None,
                account_name=posting.account.account_name if posting.account else None,
                units=MoneyValue(amount=posting.units_amount, symbol=posting.units_symbol),
                narration=posting.narration,
                cost=None
                if posting.cost_per_unit is None
                else MoneyValue(
                    amount=posting.cost_per_unit, symbol=cast(str, posting.cost_symbol)
                ),
                price=None
                if posting.price_per_unit is None
                else MoneyValue(
                    amount=posting.price_per_unit, symbol=cast(str, posting.price_symbol)
                ),
                weight=weight,
                converted_weights=_converted_weight(
                    weight, transaction.transaction_date, price_lookup
                ),
                entity_metadata=posting.entity_metadata,
            )
        )

    import_metadata = (
        ImportMetadata(
            source_native_ids=transaction.source_native_ids,
            import_timestamp=transaction.import_timestamp,
        )
        if (transaction.source_native_ids or transaction.import_timestamp)
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
        update_time=transaction.updated_at,
    )


def normalize_transaction(
    session: Session,
    payload: TransactionNormalizeData,
) -> NormalizeTransactionResponse:
    # :normalize never persists (draft preview only) — it computes exactly
    # what persist_transaction would store, via the same
    # _prepare_canonical_transaction pipeline, and just doesn't write it.
    prepared, _account_map = _prepare_canonical_transaction(session, payload)
    return NormalizeTransactionResponse(transaction=prepared)


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
        pg_sql = (
            "SELECT t.name, c.v"
            " FROM transactions t,"
            " jsonb_array_elements_text(t.source_native_ids) AS tv,"
            " jsonb_array_elements_text(CAST(:ids_json AS jsonb)) AS c(v)"
            " WHERE tv = c.v"
        )
        if exclude_name is not None:
            pg_sql += " AND t.name != :exclude"
        pg_sql += " LIMIT 1"
        stmt = text(pg_sql).bindparams(ids_json=json.dumps(ids))
        if exclude_name is not None:
            stmt = stmt.bindparams(exclude=exclude_name)
        rows = session.execute(stmt).all()
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
    payload: TransactionCreate | TransactionNormalizeData,
    transaction: Transaction | None = None,
    update_mask: str | None = None,
) -> Transaction:
    # persist_transaction is the single chokepoint every postings-replacing
    # write goes through (create, update, :split, :unsplit, and every
    # importer via create_transaction). It accepts a raw payload — possibly
    # narrowly incomplete, per normalization's contract — rather than
    # trusting its caller to have already normalized it: preparing the
    # canonical (fully explicit, fully balanced) form is this function's own
    # first step, not a precondition callers have to remember to satisfy.
    prepared, account_map = _prepare_canonical_transaction(session, payload)

    is_create = transaction is None
    mask = set(update_mask.split(",")) if (update_mask and not is_create) else None

    def _masked(field: str) -> bool:
        return mask is None or field in mask

    if _masked("import_metadata"):
        new_ids = prepared.import_metadata.source_native_ids if prepared.import_metadata else []
        new_ts = prepared.import_metadata.import_timestamp if prepared.import_metadata else None
        exclude = None if is_create else transaction.name
        _check_source_ids_available(session, new_ids, exclude_name=exclude)

    if is_create:
        transaction = Transaction(name=generate_resource_name("transactions", "txn"))
        session.add(transaction)

    # Every persist is a mutation, even a postings-only update_mask — bump
    # unconditionally (see Transaction.updated_at in models/ledger.py).
    transaction.updated_at = current_update_time()

    if _masked("transaction_date"):
        transaction.transaction_date = prepared.transaction_date
    if _masked("payee"):
        transaction.payee = prepared.payee
    if _masked("narration"):
        transaction.narration = prepared.narration
    if _masked("entity_metadata"):
        transaction.entity_metadata = prepared.entity_metadata
    if _masked("import_metadata"):
        transaction.source_native_ids = new_ids
        transaction.import_timestamp = new_ts
    if _masked("tags"):
        transaction.tags = prepared.tags
    if _masked("postings"):
        transaction.postings.clear()
        if transaction.id is not None:
            # Flush orphaned postings before reusing posting_order values on replacement updates.
            session.flush()

        for index, posting in enumerate(prepared.postings, start=1):
            account = (
                None
                if posting.account is None
                else account_map[resource_name("accounts", posting.account)]
            )
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


def get_transaction_row(
    session: Session, transaction: str, *, for_update: bool = False
) -> Transaction:
    resource = resource_name("transactions", transaction)
    query = (
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .where(Transaction.name == resource)
    )
    if for_update:
        # Real row lock on Postgres — a concurrent :split/:unsplit on the
        # same transaction blocks until this one commits, then re-reads the
        # now-changed updated_at and correctly fails its own precondition
        # check. Silently dropped (harmless no-op) by SQLite's dialect,
        # which doesn't support FOR UPDATE — fine, since SQLite's
        # single-writer model doesn't need real row locking anyway.
        query = query.with_for_update()
    transaction_row = session.scalar(query)
    if transaction_row is None:
        raise NotFoundError(code="transaction_not_found", message="Transaction not found")
    return transaction_row


def _check_update_time_precondition(transaction_row: Transaction, client_update_time: int) -> None:
    if transaction_row.updated_at != client_update_time:
        raise ConflictError(
            code="transaction_version_mismatch",
            message=(
                f"Transaction was modified since update_time={client_update_time}; "
                f"current update_time is {transaction_row.updated_at}."
            ),
        )


def _cost_or_price_key(
    posting: Posting,
) -> tuple[Decimal | None, str | None, Decimal | None, str | None]:
    return (
        posting.cost_per_unit,
        posting.cost_symbol,
        posting.price_per_unit,
        posting.price_symbol,
    )


def _posting_payload_from_orm(posting: Posting) -> PostingNormalizePayload:
    return PostingNormalizePayload(
        account=posting.account.name if posting.account else None,
        units=MoneyValue(amount=posting.units_amount, symbol=posting.units_symbol),
        narration=posting.narration,
        cost=None
        if posting.cost_per_unit is None
        else MoneyValue(amount=posting.cost_per_unit, symbol=cast(str, posting.cost_symbol)),
        price=None
        if posting.price_per_unit is None
        else MoneyValue(amount=posting.price_per_unit, symbol=cast(str, posting.price_symbol)),
        entity_metadata=posting.entity_metadata,
    )


def _synthetic_posting_payload(money: MoneyValue) -> PostingPayload:
    return PostingPayload(account=None, account_name=None, units=money, weight=money)


def _postings_balanced_with_residual_fillers(
    postings: list[PostingPayload],
) -> list[PostingPayload]:
    """Appends one account=None posting per symbol needed to bring
    [postings] to a full balance (accountless entries included in the sum —
    see compute_full_balance_residuals_for_payload). Used by
    _prepare_canonical_transaction as the last step of preparing a payload,
    whether it's about to be persisted or just previewed by :normalize."""
    residuals = compute_full_balance_residuals_for_payload(postings)
    if not residuals:
        return postings
    return postings + [_synthetic_posting_payload(r) for r in residuals]


def _prepare_canonical_transaction(
    session: Session, payload: TransactionCreate | TransactionNormalizeData
) -> tuple[TransactionCreate, dict[str, Account]]:
    """The one invariant every stored (or previewed) transaction must
    satisfy: fully explicit postings (normalize_and_validate_transaction_payload)
    that fully balance (_postings_balanced_with_residual_fillers). This is
    called exactly twice: by persist_transaction, as the first step of
    actually writing a transaction, and by normalize_transaction, which
    computes the same canonical result but never writes it anywhere."""
    normalized, account_map = normalize_and_validate_transaction_payload(session, payload)
    prepared = normalized.model_copy(
        update={"postings": _postings_balanced_with_residual_fillers(normalized.postings)}
    )
    return prepared, account_map


def _find_unsplit_merge_target(
    postings: list[Posting], posting_index: int, target: Posting
) -> int | None:
    """First other posting matching target's symbol, cost/price, and *weight*
    sign (both >= 0 or both < 0). Sign-matching keeps this from ever
    selecting the conventional negative "source" posting as the merge
    target for a positive destination.
    Compares weight (persisted_posting_weight), not raw units_amount, so
    this stays correct even for a cost/price-bearing posting whose rate
    happens to be negative — weight is this codebase's canonical signed
    value everywhere else (transaction_balancing.py), and using it here too
    means correctness doesn't depend on readers re-deriving that a matching
    cost/price rate (required below) makes the two comparisons equivalent.
    A match can itself be accountless: merging an accounted posting into a
    filler is a valid way to move it back to "not yet categorized" (the
    reverse of the ordinary "categorize a filler" direction), just like
    merging two accountless postings together is fine too."""
    target_key = _cost_or_price_key(target)
    target_nonneg = persisted_posting_weight(target).amount >= 0
    for index, candidate in enumerate(postings):
        if index == posting_index:
            continue
        if candidate.units_symbol != target.units_symbol:
            continue
        if _cost_or_price_key(candidate) != target_key:
            continue
        if (persisted_posting_weight(candidate).amount >= 0) != target_nonneg:
            continue
        return index
    return None


def _transaction_payload_from_row(
    transaction: Transaction, postings: list[PostingNormalizePayload], narration: str | None
) -> TransactionNormalizeData:
    return TransactionNormalizeData(
        transaction_date=transaction.transaction_date,
        payee=transaction.payee,
        narration=narration,
        tags=transaction.tags,
        entity_metadata=transaction.entity_metadata,
        import_metadata=None,
        postings=postings,
    )


def split_transaction(
    session: Session, transaction: str, request: SplitTransactionRequest
) -> TransactionResource:
    transaction_row = get_transaction_row(session, transaction, for_update=True)
    _check_update_time_precondition(transaction_row, request.update_time)

    postings = transaction_row.postings
    if not (0 <= request.posting_index < len(postings)):
        raise ValidationError(
            code="posting_index_out_of_range", message="posting_index is out of range."
        )

    # Read the target's amount/symbol off the ORM row (plainly typed —
    # Decimal/str, no Optional-union narrowing needed), but source cost/price
    # for the remainder from the already-built payload entry, so they're
    # derived exactly once (by _posting_payload_from_orm) rather than
    # recomputed from ORM fields a second time. Same split as
    # unsplit_transaction: ORM for reading facts about existing postings,
    # the payload list for describing the new state to persist.
    target = postings[request.posting_index]
    symbol = target.units_symbol
    remainder_amount = request.split_off_amount
    new_target_amount = target.units_amount - request.split_off_amount

    payload_postings = [_posting_payload_from_orm(p) for p in postings]
    target_payload = payload_postings[request.posting_index]
    payload_postings[request.posting_index] = target_payload.model_copy(
        update={"units": MoneyValue(amount=new_target_amount, symbol=symbol)}
    )
    if remainder_amount != 0:
        payload_postings.insert(
            request.posting_index + 1,
            PostingNormalizePayload(
                account=None,
                units=MoneyValue(amount=remainder_amount, symbol=symbol),
                # Cost/price are per-unit rates, unaffected by how the
                # quantity is divided — copy the target's verbatim onto the
                # new remainder posting; the target keeps its own cost/price
                # unchanged, only its amount changes.
                cost=target_payload.cost,
                price=target_payload.price,
            ),
        )

    persist_transaction(
        session,
        _transaction_payload_from_row(transaction_row, payload_postings, transaction_row.narration),
        transaction=transaction_row,
        update_mask="postings",
    )
    commit_or_raise(session)
    return serialize_transaction(_reload_transaction_by_id(session, transaction_row.id))


def unsplit_transaction(
    session: Session, transaction: str, request: UnsplitTransactionRequest
) -> TransactionResource:
    transaction_row = get_transaction_row(session, transaction, for_update=True)
    _check_update_time_precondition(transaction_row, request.update_time)

    postings = transaction_row.postings
    if not (0 <= request.posting_index < len(postings)):
        raise ValidationError(
            code="posting_index_out_of_range", message="posting_index is out of range."
        )

    target = postings[request.posting_index]
    payload_postings = [_posting_payload_from_orm(p) for p in postings]

    merge_into_index = _find_unsplit_merge_target(postings, request.posting_index, target)

    if merge_into_index is None:
        # An accounted posting's amount must always be merged somewhere,
        # never just discarded — only a not-yet-categorized accountless
        # posting can be deleted outright with no merge target. Removing it
        # here just reopens the gap it was covering; the persist below will
        # re-synthesize an equivalent filler posting, so the resulting
        # postings are unchanged (see persist_transaction) — but this isn't
        # a no-op in every sense: update_time still bumps, and this specific
        # posting's entity_metadata (if any) is not carried over to its
        # replacement.
        if target.account is not None:
            raise ValidationError(
                code="merge_target_not_found",
                message="No posting matches posting_index's symbol, cost, price, and sign.",
            )
    else:
        survivor = postings[merge_into_index]
        merged_amount = survivor.units_amount + target.units_amount
        payload_postings[merge_into_index] = payload_postings[merge_into_index].model_copy(
            update={"units": MoneyValue(amount=merged_amount, symbol=survivor.units_symbol)}
        )

    del payload_postings[request.posting_index]

    persist_transaction(
        session,
        _transaction_payload_from_row(transaction_row, payload_postings, transaction_row.narration),
        transaction=transaction_row,
        update_mask="postings",
    )
    commit_or_raise(session)
    return serialize_transaction(_reload_transaction_by_id(session, transaction_row.id))


def create_transaction(
    session: Session,
    payload: TransactionCreate | TransactionNormalizeData,
) -> TransactionResource:
    transaction = persist_transaction(session, payload)
    commit_or_raise(session)
    return serialize_transaction(_reload_transaction_by_id(session, transaction.id))


def update_transaction(
    session: Session,
    transaction: str,
    payload: TransactionCreate | TransactionNormalizeData,
    update_mask: str | None = None,
) -> TransactionResource:
    transaction_row = get_transaction_row(session, transaction)
    persist_transaction(session, payload, transaction=transaction_row, update_mask=update_mask)
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
    account_name: str | None,
    currency: str | None = None,
    last_import: bool = False,
    order: Literal["asc", "desc"] = "asc",
    convert: str | None = None,
) -> ListTransactionsResponse:
    if account is not None and account_name is not None:
        raise ValidationError(
            code="conflicting_account_filters",
            message="account and account_name cannot both be set",
        )
    query = select(Transaction).options(
        selectinload(Transaction.postings).selectinload(Posting.account)
    )
    if last_import:
        max_ts = select(func.max(Transaction.import_timestamp)).scalar_subquery()
        query = query.where(Transaction.import_timestamp == max_ts)
    if from_date is not None:
        query = query.where(Transaction.transaction_date >= from_date)
    if to_date is not None:
        query = query.where(Transaction.transaction_date <= to_date)
    # account/account_name/currency all scope by posting; combined into one
    # subquery over a single Posting join so a transaction only matches when
    # the *same* posting satisfies every active condition (e.g. account_name
    # + currency together requires one posting in that subtree AND in that
    # commodity, not two different postings independently). account and
    # account_name are mutually exclusive (guarded above), so at most one of
    # them ever contributes a condition here.
    posting_conditions = []
    if account is not None:
        resolved = resource_name("accounts", account)
        posting_conditions.append(Account.name == resolved)
    if account_name is not None:
        posting_conditions.append(account_subtree_clause(Account.account_name, account_name))
    if currency is not None:
        posting_conditions.append(Posting.units_symbol == currency)
    if posting_conditions:
        matching_ids = select(Transaction.id).join(Transaction.postings)
        if account is not None or account_name is not None:
            matching_ids = matching_ids.join(Posting.account)
        matching_ids = matching_ids.where(*posting_conditions)
        query = query.where(Transaction.id.in_(matching_ids))
    if order == "desc":
        query = query.order_by(Transaction.transaction_date.desc(), Transaction.name.desc())
    else:
        query = query.order_by(Transaction.transaction_date, Transaction.name)
    transactions, next_page_token = run_list_page(
        session, query, page_size=page_size, page_token=page_token
    )
    price_lookup = _build_price_lookup(session, transactions, convert)
    return ListTransactionsResponse(
        transactions=[serialize_transaction(t, price_lookup=price_lookup) for t in transactions],
        next_page_token=next_page_token,
    )


def _build_price_lookup(
    session: Session, transactions: list[Transaction], convert: str | None
) -> PriceLookup | None:
    """One price load scoped to the currencies and dates the given
    transactions actually contain (same pattern as the reporting query
    executor). Shared by the list and single-transaction read paths so a
    transaction's converted amounts don't disappear depending on which one
    served it (e.g. right after an edit)."""
    if convert is None or not transactions:
        return None
    foreign = {
        weight.symbol
        for transaction in transactions
        for posting in transaction.postings
        if (weight := persisted_posting_weight(posting)).symbol != convert
    }
    # Still build a lookup even when nothing needs an actual price row: a
    # posting whose weight already is `convert` needs the lookup's
    # `.target` to resolve via _converted_weight's identity path, not a
    # DB-backed rate. PriceLookup itself skips the query when `currencies`
    # is empty, so this stays cheap.
    return PriceLookup(
        session,
        foreign,
        convert,
        max(transaction.transaction_date for transaction in transactions),
    )


def get_transaction_by_name(
    session: Session, transaction: str, *, convert: str | None = None
) -> TransactionResource:
    transaction_row = get_transaction_row(session, transaction)
    price_lookup = _build_price_lookup(session, [transaction_row], convert)
    return serialize_transaction(transaction_row, price_lookup=price_lookup)


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
        result_postings.append(pp)
        if pp.account_id is not None:
            primary_key[_posting_key(pp)] = pp
    for sp in secondary.postings:
        # Accountless postings carry no identity beyond amount/symbol —
        # deduping them against each other would silently conflate two
        # unrelated gaps that happen to share an amount, so every
        # accountless posting from both sides is always kept.
        if sp.account_id is None:
            result_postings.append(sp)
            continue
        key = _posting_key(sp)
        if key in primary_key:
            if not primary_key[key].narration and sp.narration:
                narration_overrides[key] = sp.narration
        else:
            result_postings.append(sp)

    merged_ids = list(dict.fromkeys(primary.source_native_ids + secondary.source_native_ids))
    merged_ts = max(
        (t for t in [primary.import_timestamp, secondary.import_timestamp] if t is not None),
        default=None,
    )

    merged = Transaction(
        name=generate_resource_name("transactions", "txn"),
        transaction_date=primary.transaction_date,
        payee=merged_payee,
        narration=merged_narration,
        tags=list(dict.fromkeys(primary.tags + secondary.tags)),
        entity_metadata=primary.entity_metadata,
        source_native_ids=merged_ids,
        import_timestamp=merged_ts,
        updated_at=current_update_time(),
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
