from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
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
    PostingPayload,
    PriceCreate,
    TransactionCreate,
)
from family_ledger.config import get_ledger_config
from family_ledger.db import SessionLocal
from family_ledger.models import Account, BalanceAssertion, Commodity
from family_ledger.models import Price as PriceModel
from family_ledger.models import Transaction as TransactionModel
from family_ledger.services import ledger as ledger_service

SUPPORTED_ENTRY_TYPES = (Open, Close, CommodityEntry, Transaction, Price, Balance)


@dataclass
class ImportSummary:
    accounts: int = 0
    commodities: int = 0
    transactions: int = 0
    prices: int = 0
    balance_assertions: int = 0
    options_seen: dict[str, list[str]] | None = None


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
    return MoneyValue(amount=Decimal(str(amount.number)), symbol=amount.currency)


def posting_cost_value(posting: Posting) -> MoneyValue | None:
    cost = posting.cost
    if cost is None:
        return None

    number = getattr(cost, "number", None)
    currency = getattr(cost, "currency", None)
    if number is None or currency is None:
        return None

    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def posting_payload(posting: Posting, account_names: dict[str, str]) -> PostingPayload:
    price = None if posting.price is None else money_value(cast(Amount, posting.price))
    return PostingPayload(
        account=account_names[posting.account],
        units=money_value(cast(Amount, posting.units)),
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


def create_transactions(session, entries: Sequence[object], account_names: dict[str, str]) -> int:
    count = 0
    for entry in entries:
        if isinstance(entry, Transaction):
            payload = TransactionCreate(
                transaction_date=entry.date,
                payee=entry.payee,
                narration=entry.narration,
                postings=[posting_payload(posting, account_names) for posting in entry.postings],
            )
            ledger_service.create_transaction(session, payload)
            count += 1
    return count


def create_prices(session, entries: Sequence[object]) -> int:
    count = 0
    for entry in entries:
        if isinstance(entry, Price):
            ledger_service.create_price(
                session,
                PriceCreate(
                    price_date=entry.date,
                    base_symbol=entry.currency,
                    quote=money_value(entry.amount),
                ),
            )
            count += 1
    return count


def create_balance_assertions(
    session, entries: Sequence[object], account_names: dict[str, str]
) -> int:
    count = 0
    for entry in entries:
        if isinstance(entry, Balance):
            ledger_service.create_balance_assertion(
                session,
                BalanceAssertionCreate(
                    assertion_date=entry.date,
                    account=account_names[entry.account],
                    amount=money_value(entry.amount),
                ),
            )
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

    unsupported = collect_unsupported_entries(entries)
    if unsupported:
        counts = unsupported_entry_counts(entries)
        details = ", ".join(f"{name}={count}" for name, count in counts.items())
        raise RuntimeError(f"Unsupported Beancount entry types: {details}")

    accounts = create_accounts(session, entries)
    commodities = create_commodities(session, entries)
    transactions = create_transactions(session, entries, accounts)
    prices = create_prices(session, entries)
    assertions = create_balance_assertions(session, entries, accounts)

    config = get_ledger_config()
    options = option_summary(options_map)
    if "operating_currency" in options:
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
    )


def print_summary(summary: ImportSummary) -> None:
    print("Beancount import completed.")
    print(f"Accounts: {summary.accounts}")
    print(f"Commodities: {summary.commodities}")
    print(f"Transactions: {summary.transactions}")
    print(f"Prices: {summary.prices}")
    print(f"Balance assertions: {summary.balance_assertions}")
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
