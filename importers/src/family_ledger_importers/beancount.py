from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from beancount.core.amount import Amount
from beancount.core.data import Balance, Close, Open, Posting, Price, Transaction
from beancount.core.data import Commodity as CommodityEntry
from beancount.parser import parser
from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    AccountCreate,
    BalanceAssertionCreate,
    CommodityCreate,
    ImportMetadata,
    MoneyValue,
    NormalizeMoneyValue,
    NormalizePriceValue,
    PostingNormalizePayload,
    PriceCreate,
    TransactionNormalizeData,
)
from family_ledger.importers.base import BaseImporter, EntityCounts, ImportResult
from family_ledger.models import Account
from family_ledger.services import ledger as ledger_service
from family_ledger.services.errors import ConflictError

SUPPORTED_ENTRY_TYPES = (Open, Close, CommodityEntry, Transaction, Price, Balance)
MAX_SKIPPED_EXAMPLES_PER_REASON = 10
POSTING_COMMENT_CONFIG_KEY = "import_posting_comments_as_narration"
POSTING_LINE_PATTERN = re.compile(r"^\s+[^;\s].*")
_BEANCOUNT_INTERNAL_META_KEYS = frozenset({"filename", "lineno"})


def _load_beancount_string(text: str):  # type: ignore[no-untyped-def]
    return parser.parse_string(text)


def _money_value(amount: Amount) -> MoneyValue:
    number = getattr(amount, "number", None)
    currency = getattr(amount, "currency", None)
    if number is None or currency is None:
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def _optional_money_value(amount: Amount | None) -> MoneyValue | NormalizeMoneyValue | None:
    if amount is None:
        return None
    number = getattr(amount, "number", None)
    currency = getattr(amount, "currency", None)
    if not isinstance(currency, str):
        currency = None
    if number is None and currency is None:
        return None
    if number is not None and currency is None:
        return NormalizeMoneyValue(amount=Decimal(str(number)), symbol=None)
    if number is None or currency is None:
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def _optional_explicit_money_value(amount: Amount | None) -> MoneyValue | None:
    value = _optional_money_value(amount)
    if value is None:
        return None
    if isinstance(value, NormalizeMoneyValue):
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return value


def _optional_price_value(amount: Amount | None) -> MoneyValue | NormalizePriceValue | None:
    if amount is None:
        return None
    number = getattr(amount, "number", None)
    currency = getattr(amount, "currency", None)
    if not isinstance(currency, str):
        currency = None
    # Beancount uses a MISSING sentinel for interpolated price amounts.
    if number is None or not isinstance(number, Decimal):
        if currency is not None:
            return NormalizePriceValue(symbol=currency)
        return None
    if currency is None:
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return MoneyValue(amount=number, symbol=currency)


def _posting_cost_value(posting: Posting) -> MoneyValue | None:
    cost = posting.cost
    if cost is None:
        return None
    number = getattr(cost, "number", None)
    currency = getattr(cost, "currency", None)
    if number is None:
        number = getattr(cost, "number_per", None)
    if number is None:
        number_total = getattr(cost, "number_total", None)
        units_number = getattr(getattr(posting, "units", None), "number", None)
        if number_total is not None and units_number not in (None, 0):
            number = number_total / units_number
    if number is None or currency is None:
        return None
    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def _extract_beancount_meta(entry_meta: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in entry_meta.items() if k not in _BEANCOUNT_INTERNAL_META_KEYS}


def _posting_comment_by_line(text: str) -> dict[int, str]:
    comments: dict[int, str] = {}
    for index, line in enumerate(text.splitlines(), start=1):
        if not POSTING_LINE_PATTERN.match(line):
            continue
        comment_start = line.find(";")
        if comment_start < 0:
            continue
        comment = line[comment_start + 1 :].strip()
        if comment:
            comments[index] = comment
    return comments


def _posting_payload(
    posting: Posting,
    account_names: dict[str, str],
    narration: str | None = None,
) -> PostingNormalizePayload:
    price = _optional_price_value(cast(Amount | None, posting.price))
    units = _optional_money_value(cast(Amount | None, posting.units))
    return PostingNormalizePayload(
        account=account_names[posting.account],
        units=units,
        narration=narration,
        cost=_posting_cost_value(posting),
        price=price,
    )


def _build_account_creates(entries: Sequence[object]) -> dict[str, AccountCreate]:
    accounts: dict[str, AccountCreate] = {}
    for entry in entries:
        if isinstance(entry, Open):
            accounts[entry.account] = AccountCreate(
                account_name=entry.account,
                effective_start_date=entry.date,
                effective_end_date=None,
            )
    for entry in entries:
        if isinstance(entry, Close) and entry.account in accounts:
            accounts[entry.account] = accounts[entry.account].model_copy(
                update={"effective_end_date": entry.date}
            )
    return accounts


def _discover_commodity_symbols(entries: Sequence[object]) -> list[str]:
    symbols: set[str] = set()
    for entry in entries:
        if isinstance(entry, CommodityEntry):
            symbols.add(entry.currency)
        elif isinstance(entry, Open):
            for currency in getattr(entry, "currencies", ()) or ():
                if isinstance(currency, str):
                    symbols.add(currency)
        elif isinstance(entry, Price):
            symbols.add(entry.currency)
            symbols.add(entry.amount.currency)
        elif isinstance(entry, Balance):
            symbols.add(entry.amount.currency)
        elif isinstance(entry, Transaction):
            for posting in entry.postings:
                for attr in ("units", "cost", "price"):
                    cur = getattr(getattr(posting, attr, None), "currency", None)
                    if isinstance(cur, str):
                        symbols.add(cur)
    return sorted(symbols)


class BeancountImporter(BaseImporter):
    name = "beancount"
    display_name = "Beancount"

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                POSTING_COMMENT_CONFIG_KEY: {
                    "type": "boolean",
                    "default": False,
                    "description": (
                        "Import trailing Beancount posting comments ('; ...') as posting "
                        "narrations. Only supported for directly uploaded files; "
                        "Beancount include directives are not supported."
                    ),
                }
            },
            "additionalProperties": False,
        }

    def execute(
        self,
        session: Session,
        file_data: bytes,
        config: dict[str, Any],
    ) -> ImportResult:
        text = file_data.decode("utf-8")
        entries, errors, _options_map = _load_beancount_string(text)
        posting_comments = (
            _posting_comment_by_line(text) if config.get(POSTING_COMMENT_CONFIG_KEY) else {}
        )

        if errors:
            messages = "; ".join(str(getattr(e, "message", e)) for e in errors)
            raise ConflictError(
                code="beancount_parse_error",
                message=f"Beancount parse errors: {messages}",
            )

        result = ImportResult()

        # Warn about unrecognized entry types
        unrecognized: Counter[str] = Counter()
        for entry in entries:
            if not isinstance(entry, SUPPORTED_ENTRY_TYPES):
                unrecognized[type(entry).__name__] += 1
        for type_name, count in sorted(unrecognized.items()):
            result.warnings.append(f"Unrecognized entry type: {type_name} ({count} occurrences)")

        # Accounts
        account_names: dict[str, str] = {}
        for account_name, payload in _build_account_creates(entries).items():
            try:
                resource = ledger_service.create_account(session, payload)
                account_names[account_name] = resource.name
                result.entities.setdefault("account", EntityCounts()).created += 1
            except ConflictError:
                existing = session.scalar(
                    select(Account).where(Account.account_name == payload.account_name)
                )
                if existing is not None:
                    account_names[account_name] = existing.name
                result.entities.setdefault("account", EntityCounts()).duplicate += 1

        # Commodities
        for symbol in _discover_commodity_symbols(entries):
            try:
                ledger_service.create_commodity(session, CommodityCreate(symbol=symbol))
                result.entities.setdefault("commodity", EntityCounts()).created += 1
            except ConflictError:
                result.entities.setdefault("commodity", EntityCounts()).duplicate += 1

        # Transactions
        occurrence_counter: Counter[tuple[object, ...]] = Counter()
        for entry in entries:
            if not isinstance(entry, Transaction):
                continue
            try:
                posting_payloads: list[PostingNormalizePayload] = []
                for posting in entry.postings:
                    try:
                        posting_meta = getattr(posting, "meta", None) or {}
                        line_number = posting_meta.get("lineno")
                        narration = (
                            posting_comments.get(line_number)
                            if isinstance(line_number, int)
                            else None
                        )
                        posting_payloads.append(_posting_payload(posting, account_names, narration))
                    except ValueError as exc:
                        txn_errors = result.entities.setdefault(
                            "transaction", EntityCounts()
                        ).errors
                        txn_errors.count += 1
                        if len(txn_errors.examples) < MAX_SKIPPED_EXAMPLES_PER_REASON:
                            txn_errors.examples.append(
                                f"{entry.date} {entry.payee or ''} {entry.narration or ''}: {exc}"
                            )
                        raise
                beancount_meta = _extract_beancount_meta(getattr(entry, "meta", None) or {})
                entity_metadata: dict[str, Any] = (
                    {"beancount": beancount_meta} if beancount_meta else {}
                )
                raw_native_id = beancount_meta.get("source_native_id")
                ref = beancount_meta.get("ref")
                if raw_native_id is not None:
                    source_native_id = str(raw_native_id)
                elif ref is not None:
                    source_native_id = f"beancount:{ref}"
                else:
                    key: tuple[object, ...] = (entry.date, entry.payee, entry.narration)
                    occurrence = occurrence_counter[key]
                    fp_content = {
                        "date": entry.date.isoformat(),
                        "payee": entry.payee,
                        "narration": entry.narration,
                        "occurrence": occurrence,
                    }
                    digest = hashlib.sha256(
                        json.dumps(fp_content, sort_keys=True, separators=(",", ":")).encode()
                    )
                    source_native_id = f"beancount:fp:{digest.hexdigest()}"
                    occurrence_counter[key] += 1
                payload = TransactionNormalizeData(
                    transaction_date=entry.date,
                    payee=entry.payee,
                    narration=entry.narration,
                    postings=posting_payloads,
                    entity_metadata=entity_metadata,
                    import_metadata=ImportMetadata(source_native_id=source_native_id),
                )
            except ValueError:
                continue
            except InvalidOperation as exc:
                txn_errors = result.entities.setdefault("transaction", EntityCounts()).errors
                txn_errors.count += 1
                if len(txn_errors.examples) < MAX_SKIPPED_EXAMPLES_PER_REASON:
                    txn_errors.examples.append(str(exc))
                continue
            try:
                ledger_service.create_transaction(session, payload)
                result.entities.setdefault("transaction", EntityCounts()).created += 1
            except ConflictError:
                result.entities.setdefault("transaction", EntityCounts()).duplicate += 1

        # Prices
        for entry in entries:
            if not isinstance(entry, Price):
                continue
            try:
                ledger_service.create_price(
                    session,
                    PriceCreate(
                        price_date=entry.date,
                        base_symbol=entry.currency,
                        quote=_money_value(entry.amount),
                    ),
                )
                result.entities.setdefault("price", EntityCounts()).created += 1
            except ConflictError:
                result.entities.setdefault("price", EntityCounts()).duplicate += 1

        # Balance assertions
        for entry in entries:
            if not isinstance(entry, Balance):
                continue
            try:
                ledger_service.create_balance_assertion(
                    session,
                    BalanceAssertionCreate(
                        assertion_date=entry.date,
                        account=account_names[entry.account],
                        amount=_money_value(entry.amount),
                    ),
                )
                result.entities.setdefault("balance_assertion", EntityCounts()).created += 1
            except ConflictError:
                result.entities.setdefault("balance_assertion", EntityCounts()).duplicate += 1

        return result
