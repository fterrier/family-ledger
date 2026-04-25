from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from family_ledger.api.schemas import DoctorIssue, DoctorLedgerRequest, DoctorLedgerResponse
from family_ledger.models import Posting, Transaction
from family_ledger.services.balancing import build_transaction_unbalanced_issues, decimal_to_string
from family_ledger.services.booking import BookingMethod, BookingReplay, LotKey, TransactionLotDelta


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


def load_transactions_for_doctor(session: Session) -> list[Transaction]:
    return cast(
        list[Transaction],
        session.scalars(
            select(Transaction)
            .options(selectinload(Transaction.postings).selectinload(Posting.account))
            .order_by(Transaction.transaction_date, Transaction.name)
        ).all(),
    )


def doctor_ledger(session: Session, request: DoctorLedgerRequest) -> DoctorLedgerResponse:
    del request
    transactions = load_transactions_for_doctor(session)
    transaction_order = {transaction.name: index for index, transaction in enumerate(transactions)}
    issues = [
        *[
            issue
            for transaction in transactions
            for issue in build_transaction_unbalanced_issues(transaction)
        ],
        *build_lot_match_missing_issues(transactions, booking_method=BookingMethod.FIFO),
    ]
    return DoctorLedgerResponse(
        issues=sorted(
            issues,
            key=lambda issue: (
                transaction_order.get(issue.target, len(transaction_order)),
                issue.code,
            ),
        )
    )
