from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import PostingPayload, TransactionData
from family_ledger.models import Account, Commodity
from family_ledger.services.errors import ValidationError


def resource_name(prefix: str, value: str) -> str:
    return value if "/" in value else f"{prefix}/{value}"


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


def validate_transaction_payload(session: Session, payload: TransactionData) -> None:
    account_map = resolve_accounts(session, payload.postings)
    validate_account_dates(payload.transaction_date, account_map)
    validate_transaction_symbols(session, payload)
