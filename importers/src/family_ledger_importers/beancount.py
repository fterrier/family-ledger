from __future__ import annotations

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
    MoneyValue,
    NormalizeMoneyValue,
    NormalizePriceValue,
    PostingNormalizePayload,
    PriceCreate,
    TransactionNormalizeData,
)
from family_ledger.importers.base import BaseImporter, EntityCounts, ImportResult
from family_ledger.models import Account, BalanceAssertion, Commodity
from family_ledger.models import Price as PriceModel
from family_ledger.models import Transaction as TransactionModel
from family_ledger.services import ledger as ledger_service
from family_ledger.services.errors import ConflictError

SUPPORTED_ENTRY_TYPES = (Open, Close, CommodityEntry, Transaction, Price, Balance)
MAX_SKIPPED_EXAMPLES_PER_REASON = 10


def _database_is_empty(session: Session) -> bool:
    core_models = [Account, Commodity, TransactionModel, PriceModel, BalanceAssertion]
    return all(session.scalar(select(model.id).limit(1)) is None for model in core_models)


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


def _posting_payload(posting: Posting, account_names: dict[str, str]) -> PostingNormalizePayload:
    price = _optional_price_value(cast(Amount | None, posting.price))
    units = _optional_money_value(cast(Amount | None, posting.units))
    return PostingNormalizePayload(
        account=account_names[posting.account],
        units=units,
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

    def execute(
        self,
        session: Session,
        file_data: bytes,
        config: dict[str, Any],
    ) -> ImportResult:
        if not _database_is_empty(session):
            raise ConflictError(
                code="database_not_empty",
                message="Beancount import requires an empty database",
            )

        text = file_data.decode("utf-8")
        entries, errors, _options_map = _load_beancount_string(text)

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
            resource = ledger_service.create_account(session, payload)
            account_names[account_name] = resource.name
            result.entities.setdefault("account", EntityCounts()).created += 1

        # Commodities
        for symbol in _discover_commodity_symbols(entries):
            try:
                ledger_service.create_commodity(session, CommodityCreate(symbol=symbol))
                result.entities.setdefault("commodity", EntityCounts()).created += 1
            except ConflictError:
                result.entities.setdefault("commodity", EntityCounts()).duplicate += 1

        # Transactions
        for entry in entries:
            if not isinstance(entry, Transaction):
                continue
            try:
                posting_payloads: list[PostingNormalizePayload] = []
                for posting in entry.postings:
                    try:
                        posting_payloads.append(_posting_payload(posting, account_names))
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
                payload = TransactionNormalizeData(
                    transaction_date=entry.date,
                    payee=entry.payee,
                    narration=entry.narration,
                    postings=posting_payloads,
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
