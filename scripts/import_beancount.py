from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import cast

from beancount.core.amount import Amount
from beancount.core.data import Balance, Close, Open, Posting, Price, Transaction
from beancount.core.data import Commodity as CommodityEntry
from beancount.parser import parser
from sqlalchemy import select

from family_ledger.api.schemas import (
    AccountCreate,
    BalanceAssertionCreate,
    CommodityCreate,
    MoneyValue,
    PostingNormalizePayload,
    PriceCreate,
    TransactionNormalizeData,
)
from family_ledger.config import get_ledger_config
from family_ledger.db import SessionLocal
from family_ledger.models import Account, BalanceAssertion, Commodity
from family_ledger.models import Price as PriceModel
from family_ledger.models import Transaction as TransactionModel
from family_ledger.services import ledger as ledger_service
from family_ledger.services.errors import ConflictError

SUPPORTED_ENTRY_TYPES = (Open, Close, CommodityEntry, Transaction, Price, Balance)


@dataclass
class ImportSummary:
    accounts: int = 0
    commodities: int = 0
    transactions: int = 0
    prices: int = 0
    balance_assertions: int = 0
    options_seen: dict[str, list[str]] | None = None
    skipped_entries: dict[str, int] | None = None
    skipped_transactions: int = 0
    skipped_transaction_reasons: dict[str, int] | None = None
    skipped_transaction_examples: dict[str, list[str]] | None = None


MAX_SKIPPED_EXAMPLES_PER_REASON = 10


def beancount_value_repr(value) -> str:
    if value is None:
        return "None"
    return repr(value)


def describe_transaction_issue(entry: Transaction, posting: Posting | None, reason: str) -> str:
    payee = entry.payee or ""
    narration = entry.narration or ""
    base = f"{entry.date} | {payee} | {narration}"
    if posting is None:
        return base
    return (
        f"{base} | posting={posting.account} | reason={reason} | "
        f"units={beancount_value_repr(posting.units)} | "
        f"cost={beancount_value_repr(posting.cost)} | "
        f"price={beancount_value_repr(posting.price)}"
    )


def database_is_empty(session) -> bool:
    core_models = [Account, Commodity, TransactionModel, PriceModel, BalanceAssertion]
    return all(session.scalar(select(model.id).limit(1)) is None for model in core_models)


def load_beancount_document(path: Path):
    entries, errors, options_map = parser.parse_file(str(path))
    return entries, errors, options_map


def collect_unsupported_entries(entries: Sequence[object]) -> list[str]:
    unsupported = []
    for entry in entries:
        if not isinstance(entry, SUPPORTED_ENTRY_TYPES):
            unsupported.append(type(entry).__name__)
    return sorted(set(unsupported))


def unsupported_entry_counts(entries: Sequence[object]) -> dict[str, int]:
    counter = Counter()
    for entry in entries:
        if not isinstance(entry, SUPPORTED_ENTRY_TYPES):
            counter[type(entry).__name__] += 1
    return dict(sorted(counter.items()))


def money_value(amount: Amount) -> MoneyValue:
    number = getattr(amount, "number", None)
    currency = getattr(amount, "currency", None)
    if number is None or currency is None:
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def optional_money_value(amount: Amount | None) -> MoneyValue | None:
    if amount is None:
        return None

    number = getattr(amount, "number", None)
    currency = getattr(amount, "currency", None)

    if number is None and currency is None:
        return None
    if number is None or currency is None:
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")

    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def posting_cost_value(posting: Posting) -> MoneyValue | None:
    cost = posting.cost
    if cost is None:
        return None

    number = getattr(cost, "number", None)
    currency = getattr(cost, "currency", None)

    if number is None:
        number = getattr(cost, "number_per", None)
    if currency is None:
        currency = getattr(cost, "currency", None)

    if number is None:
        number_total = getattr(cost, "number_total", None)
        units_number = getattr(getattr(posting, "units", None), "number", None)
        if number_total is not None and units_number not in (None, 0):
            number = number_total / units_number

    if number is None or currency is None:
        return None

    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def posting_payload(
    posting: Posting,
    account_names: dict[str, str],
) -> PostingNormalizePayload:
    price = optional_money_value(cast(Amount | None, posting.price))
    units = optional_money_value(cast(Amount | None, posting.units))
    return PostingNormalizePayload(
        account=account_names[posting.account],
        units=units,
        cost=posting_cost_value(posting),
        price=price,
    )


def build_account_creates(entries: Sequence[object]) -> dict[str, AccountCreate]:
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


def create_accounts(session, entries: Sequence[object]) -> dict[str, str]:
    account_creates = build_account_creates(entries)
    created = {}
    for account_name, payload in account_creates.items():
        created[account_name] = ledger_service.create_account(session, payload).name
    return created


def create_commodities(session, entries: Sequence[object]) -> int:
    commodity_symbols = sorted(
        {entry.currency for entry in entries if isinstance(entry, CommodityEntry)}
        | {entry.amount.currency for entry in entries if isinstance(entry, Price)}
        | {entry.currency for entry in entries if isinstance(entry, Price)}
    )

    for symbol in commodity_symbols:
        ledger_service.create_commodity(session, CommodityCreate(symbol=symbol))

    return len(commodity_symbols)


def create_transactions(
    session, entries: Sequence[object], account_names: dict[str, str]
) -> tuple[int, int, dict[str, int], dict[str, list[str]]]:
    count = 0
    skipped = 0
    skip_reasons = Counter()
    skip_examples: dict[str, list[str]] = {}

    def record_skip(reason: str, entry: Transaction, posting: Posting | None) -> None:
        skip_reasons[reason] += 1
        examples = skip_examples.setdefault(reason, [])
        if len(examples) < MAX_SKIPPED_EXAMPLES_PER_REASON:
            examples.append(describe_transaction_issue(entry, posting, reason))

    for entry in entries:
        if isinstance(entry, Transaction):
            try:
                posting_payloads = []
                for posting in entry.postings:
                    try:
                        posting_payloads.append(posting_payload(posting, account_names))
                    except ValueError as exc:
                        skipped += 1
                        reason = str(exc)
                        if reason.startswith("Unsupported Beancount amount value"):
                            record_skip("unsupported_amount_shape", entry, posting)
                        else:
                            record_skip("unsupported_posting_shape", entry, posting)
                        raise
                payload = TransactionNormalizeData(
                    transaction_date=entry.date,
                    payee=entry.payee,
                    narration=entry.narration,
                    postings=posting_payloads,
                )
            except ValueError:
                continue
            except InvalidOperation:
                skipped += 1
                record_skip("invalid_decimal_value", entry, None)
                continue
            try:
                ledger_service.create_transaction(session, payload)
            except ConflictError:
                skipped += 1
                record_skip("fingerprint_conflict", entry, None)
                continue
            count += 1
    return count, skipped, dict(sorted(skip_reasons.items())), dict(sorted(skip_examples.items()))


def create_prices(session, entries: Sequence[object]) -> int:
    count = 0
    for entry in entries:
        if isinstance(entry, Price):
            try:
                ledger_service.create_price(
                    session,
                    PriceCreate(
                        price_date=entry.date,
                        base_symbol=entry.currency,
                        quote=money_value(entry.amount),
                    ),
                )
            except ConflictError:
                continue
            count += 1
    return count


def create_balance_assertions(
    session, entries: Sequence[object], account_names: dict[str, str]
) -> int:
    count = 0
    for entry in entries:
        if isinstance(entry, Balance):
            try:
                ledger_service.create_balance_assertion(
                    session,
                    BalanceAssertionCreate(
                        assertion_date=entry.date,
                        account=account_names[entry.account],
                        amount=money_value(entry.amount),
                    ),
                )
            except ConflictError:
                continue
            count += 1
    return count


def option_summary(options_map: dict) -> dict[str, list[str]]:
    keys = ["operating_currency", "inferred_tolerance_default", "documents", "title"]
    summary = {}
    for key in keys:
        value = options_map.get(key)
        if value is None:
            continue
        if isinstance(value, list):
            summary[key] = [str(item) for item in value]
        else:
            summary[key] = [str(value)]
    return summary


def import_beancount(session, path: Path) -> ImportSummary:
    if not database_is_empty(session):
        raise RuntimeError("Beancount import expects an empty database.")

    entries, errors, options_map = load_beancount_document(path)
    if errors:
        messages = "; ".join(str(getattr(error, "message", error)) for error in errors)
        raise RuntimeError(f"Beancount parse errors: {messages}")

    skipped_entries = unsupported_entry_counts(entries)

    accounts = create_accounts(session, entries)
    commodities = create_commodities(session, entries)
    (
        transactions,
        skipped_transactions,
        skipped_transaction_reasons,
        skipped_transaction_examples,
    ) = create_transactions(session, entries, accounts)
    prices = create_prices(session, entries)
    assertions = create_balance_assertions(session, entries, accounts)

    config = get_ledger_config()
    options = option_summary(options_map)
    if options.get("operating_currency"):
        operating_currency = options["operating_currency"][0]
        if operating_currency != config.default_currency:
            print(
                "Warning: Beancount operating currency "
                f"{operating_currency!r} differs from config default_currency "
                f"{config.default_currency!r}."
            )

    return ImportSummary(
        accounts=len(accounts),
        commodities=commodities,
        transactions=transactions,
        prices=prices,
        balance_assertions=assertions,
        options_seen=options,
        skipped_entries=skipped_entries,
        skipped_transactions=skipped_transactions,
        skipped_transaction_reasons=skipped_transaction_reasons,
        skipped_transaction_examples=skipped_transaction_examples,
    )


def print_summary(summary: ImportSummary) -> None:
    print("Beancount import completed.")
    print(f"Accounts: {summary.accounts}")
    print(f"Commodities: {summary.commodities}")
    print(f"Transactions: {summary.transactions}")
    print(f"Skipped transactions: {summary.skipped_transactions}")
    if summary.skipped_transaction_reasons:
        print("Skipped transaction reasons:")
        for key, count in summary.skipped_transaction_reasons.items():
            print(f"- {key}: {count}")
    if summary.skipped_transaction_examples:
        print("Skipped transaction examples:")
        for key, examples in summary.skipped_transaction_examples.items():
            print(f"- {key}:")
            for example in examples:
                print(f"  - {example}")
    print(f"Prices: {summary.prices}")
    print(f"Balance assertions: {summary.balance_assertions}")
    if summary.skipped_entries:
        print("Skipped unsupported entries:")
        for key, count in summary.skipped_entries.items():
            print(f"- {key}: {count}")
    if summary.options_seen:
        print("Options seen:")
        for key, values in summary.options_seen.items():
            print(f"- {key}: {', '.join(values)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import a Beancount ledger into an empty database."
    )
    parser.add_argument(
        "path",
        type=Path,
        help="Path to the Beancount file to import",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    path = args.path
    with SessionLocal() as session:
        summary = import_beancount(session, path)
    print_summary(summary)


if __name__ == "__main__":
    main()
