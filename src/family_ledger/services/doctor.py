from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from family_ledger.api.schemas import (
    DoctorIssue,
    DoctorLedgerRequest,
    DoctorLedgerResponse,
)
from family_ledger.models import BalanceAssertion, Posting, Transaction
from family_ledger.services import attachments as attachment_service
from family_ledger.services.account_balance import compute_balance_assertion_diffs
from family_ledger.services.booking import BookingMethod, BookingReplay, LotKey, TransactionLotDelta
from family_ledger.services.transaction_balancing import (
    build_transaction_unbalanced_issues,
    decimal_to_string,
    resolve_tolerance,
)


def lot_key_for_posting(posting: Posting) -> LotKey | None:
    if posting.cost_per_unit is None or posting.cost_symbol is None:
        return None
    return LotKey(
        account=posting.account.name,
        units_symbol=posting.units_symbol,
        cost_symbol=posting.cost_symbol,
        cost_per_unit=posting.cost_per_unit,
    )


def transaction_lot_deltas(
    transactions: Sequence[Transaction],
) -> dict[LotKey, list[TransactionLotDelta]]:
    lot_deltas: dict[LotKey, list[TransactionLotDelta]] = {}
    ordered_transactions = sorted(transactions, key=lambda tx: (tx.transaction_date, tx.name))

    for transaction in ordered_transactions:
        per_transaction: dict[LotKey, Decimal] = {}
        for posting in transaction.postings:
            lot_key = lot_key_for_posting(posting)
            if lot_key is None:
                continue
            per_transaction[lot_key] = (
                per_transaction.get(lot_key, Decimal("0")) + posting.units_amount
            )
        for lot_key, amount in sorted(per_transaction.items()):
            if amount == 0:
                continue
            lot_deltas.setdefault(lot_key, []).append(
                TransactionLotDelta(transaction_name=transaction.name, amount=amount)
            )
    return lot_deltas


def build_lot_match_missing_issues(
    transactions: Sequence[Transaction],
    booking_method: BookingMethod = BookingMethod.FIFO,
) -> list[DoctorIssue]:
    lot_deltas = transaction_lot_deltas(transactions)
    failures = BookingReplay(booking_method).replay(lot_deltas).failures
    return [
        DoctorIssue(
            target=failure.target,
            code="lot_match_missing",
            severity="error",
            message="Not enough lots to reduce.",
            details={
                "account": failure.lot_key.account,
                "units_symbol": failure.lot_key.units_symbol,
                "cost_symbol": failure.lot_key.cost_symbol,
                "cost_per_unit": decimal_to_string(failure.lot_key.cost_per_unit),
                "requested_amount": decimal_to_string(failure.requested_amount),
                "available_amount": decimal_to_string(failure.available_amount),
            },
        )
        for failure in failures
    ]


def _load_transactions_for_doctor(session: Session) -> list[Transaction]:
    return cast(
        list[Transaction],
        session.scalars(
            select(Transaction)
            .options(selectinload(Transaction.postings).selectinload(Posting.account))
            .order_by(Transaction.transaction_date, Transaction.name)
        ).all(),
    )


def _load_balance_assertions_for_doctor(session: Session) -> list[BalanceAssertion]:
    return cast(
        list[BalanceAssertion],
        session.scalars(
            select(BalanceAssertion)
            .options(selectinload(BalanceAssertion.account))
            .order_by(BalanceAssertion.assertion_date, BalanceAssertion.name)
        ).all(),
    )


def doctor_ledger(session: Session, request: DoctorLedgerRequest) -> DoctorLedgerResponse:
    del request
    transactions = _load_transactions_for_doctor(session)
    balance_assertion_diffs = compute_balance_assertion_diffs(
        transactions, _load_balance_assertions_for_doctor(session)
    )
    issues = [
        *[
            issue
            for transaction in transactions
            for issue in build_transaction_unbalanced_issues(transaction)
        ],
        *build_lot_match_missing_issues(transactions, booking_method=BookingMethod.FIFO),
        *[
            DoctorIssue(
                target=diff.balance_assertion,
                code="balance_assertion_failed",
                severity="error",
                message="Balance assertion not satisfied.",
                details={
                    "symbol": diff.symbol,
                    "asserted_amount": decimal_to_string(diff.expected),
                    "actual_amount": decimal_to_string(diff.actual),
                    "diff": decimal_to_string(diff.diff),
                    "tolerance": decimal_to_string(resolve_tolerance(diff.symbol)),
                },
            )
            for diff in balance_assertion_diffs
            if abs(diff.diff) > resolve_tolerance(diff.symbol)
        ],
        *attachment_service.build_attachment_doctor_issues(session),
    ]
    return DoctorLedgerResponse(issues=issues)
