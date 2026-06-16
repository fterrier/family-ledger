from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from family_ledger.api.schemas import MoneyValue, PadEntry, PadResponse
from family_ledger.models import Account, BalanceAssertion, Posting, Transaction
from family_ledger.services.errors import NotFoundError, ValidationError
from family_ledger.services.transaction_balancing import resolve_tolerance
from family_ledger.services.validation import resource_name


@dataclass
class BalanceAssertionDiff:
    balance_assertion: str
    assertion_date: date
    account_name: str
    symbol: str
    expected: Decimal
    actual: Decimal
    diff: Decimal


def compute_balance_assertion_diffs(
    transactions: Sequence[Transaction],
    balance_assertions: Sequence[BalanceAssertion],
) -> list[BalanceAssertionDiff]:
    # Precondition: transactions sorted by (transaction_date, name),
    # balance_assertions sorted by (assertion_date, name).
    running_balance: dict[str, dict[str, Decimal]] = {}
    diffs: list[BalanceAssertionDiff] = []
    tx_iter: Iterator[Transaction] = iter(transactions)
    current_tx: Transaction | None = next(tx_iter, None)

    for assertion in balance_assertions:
        assertion_date = assertion.assertion_date
        account_name = assertion.account.account_name

        while current_tx is not None and current_tx.transaction_date < assertion_date:
            for posting in current_tx.postings:
                acc = posting.account.account_name
                sym = posting.units_symbol
                if acc not in running_balance:
                    running_balance[acc] = {}
                running_balance[acc][sym] = (
                    running_balance[acc].get(sym, Decimal("0")) + posting.units_amount
                )
            current_tx = next(tx_iter, None)

        actual = sum(
            (
                balances.get(assertion.symbol, Decimal("0"))
                for acc, balances in running_balance.items()
                if acc == account_name or acc.startswith(account_name + ":")
            ),
            Decimal("0"),
        )

        diffs.append(
            BalanceAssertionDiff(
                balance_assertion=assertion.name,
                assertion_date=assertion_date,
                account_name=account_name,
                symbol=assertion.symbol,
                expected=assertion.amount,
                actual=actual,
                diff=assertion.amount - actual,
            )
        )

    return diffs


def _has_cost_tracked_positions(
    session: Session,
    account_name: str,
    units_symbol: str,
    before_date: date,
) -> bool:
    count = session.scalar(
        select(func.count())
        .select_from(Posting)
        .join(Posting.account)
        .join(Posting.transaction)
        .where(
            or_(
                Account.account_name == account_name,
                Account.account_name.like(account_name + ":%"),
            )
        )
        .where(Posting.units_symbol == units_symbol)
        .where(Posting.cost_symbol.is_not(None))
        .where(Transaction.transaction_date < before_date)
    )
    return (count or 0) > 0


def _resolve_account_for_pad(session: Session, account_name: str) -> Account:
    resolved_name = resource_name("accounts", account_name)
    account = session.scalar(select(Account).where(Account.name == resolved_name))
    if account is None:
        raise NotFoundError(code="account_not_found", message=f"Account not found: {resolved_name}")
    return account


def compute_pad(session: Session, account_name: str, pad_date: date) -> PadResponse:
    account = _resolve_account_for_pad(session, account_name)

    balance_assertions = list(
        session.scalars(
            select(BalanceAssertion)
            .options(selectinload(BalanceAssertion.account))
            .order_by(BalanceAssertion.assertion_date, BalanceAssertion.name)
            .join(BalanceAssertion.account)
            .where(Account.account_name == account.account_name)
        ).all()
    )

    matching_ids = (
        select(Transaction.id)
        .join(Transaction.postings)
        .join(Posting.account)
        .where(
            or_(
                Account.account_name == account.account_name,
                Account.account_name.like(account.account_name + ":%"),
            )
        )
    )
    transactions = list(
        session.scalars(
            select(Transaction)
            .options(selectinload(Transaction.postings).selectinload(Posting.account))
            .where(Transaction.id.in_(matching_ids))
            .order_by(Transaction.transaction_date, Transaction.name)
        ).all()
    )

    diffs = compute_balance_assertion_diffs(transactions, balance_assertions)
    future_diffs = [d for d in diffs if d.assertion_date > pad_date]

    for diff in future_diffs:
        if _has_cost_tracked_positions(
            session, account.account_name, diff.symbol, diff.assertion_date
        ):
            raise ValidationError(
                code="pad_cost_tracked_account",
                message=(
                    f"Cannot pad {account.account_name}: account has cost-tracked "
                    f"{diff.symbol} positions."
                ),
            )

    first_per_currency: dict[str, BalanceAssertionDiff] = {}
    for diff in future_diffs:
        if diff.symbol not in first_per_currency:
            first_per_currency[diff.symbol] = diff

    entries = [
        PadEntry(
            balance_assertion=diff.balance_assertion,
            assertion_date=diff.assertion_date,
            units=MoneyValue(amount=diff.diff, symbol=diff.symbol),
        )
        for diff in first_per_currency.values()
        if abs(diff.diff) > resolve_tolerance(diff.symbol)
    ]

    return PadResponse(account=account.name, pad_date=pad_date, entries=entries)
