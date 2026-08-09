from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from itertools import chain
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    DoctorIssue,
    DoctorLedgerRequest,
    DoctorLedgerResponse,
)
from family_ledger.models import (
    Account,
    Attachment,
    BalanceAssertion,
    Commodity,
    Posting,
    Transaction,
)
from family_ledger.services.account_balance import compute_balance_assertion_diffs
from family_ledger.services.booking import BookingMethod, BookingReplay, LotKey, TransactionLotDelta
from family_ledger.services.transaction_balancing import (
    build_transaction_unbalanced_issues,
    decimal_to_string,
    resolve_tolerance,
)


@dataclass
class _AccountData:
    id: int
    account_name: str
    effective_start_date: date
    effective_end_date: date | None


@dataclass
class _PostingData:
    # Doctor's transaction-loading query inner-joins Account (see
    # _load_transactions_for_doctor) — an accountless posting (a split's
    # not-yet-categorized remainder) therefore never appears here at all, by
    # design: doctor ignores it entirely until it's categorized. Its
    # *transaction* still surfaces normally as long as at least one other
    # posting has an account (always true — a split's source posting is
    # always accounted), and the unbalanced check on that transaction still
    # correctly excludes the missing posting's amount from the sum (see
    # transaction_balancing.py's own account filter, which independently
    # applies to every caller, not just doctor).
    account: _AccountData
    units_amount: Decimal
    units_symbol: str
    cost_per_unit: Decimal | None
    cost_symbol: str | None
    price_per_unit: Decimal | None
    price_symbol: str | None


@dataclass
class _TxData:
    id: int
    name: str
    transaction_date: date
    payee: str | None
    narration: str | None
    postings: list[_PostingData] = field(default_factory=list)


@dataclass
class _BalanceAssertionData:
    name: str
    assertion_date: date
    amount: Decimal
    symbol: str
    account: _AccountData


@dataclass
class _AttachmentData:
    name: str
    attachment_date: date
    original_filename: str
    status: str
    account_name: str


def _make_account_data(row) -> _AccountData:
    return _AccountData(
        id=row.account_id,
        account_name=row.account_name,
        effective_start_date=row.effective_start_date,
        effective_end_date=row.effective_end_date,
    )


_ATTACHMENT_STATUS_INFO: dict[str, tuple[str, str]] = {
    Attachment.STATUS_PENDING_UPLOAD: (
        "attachment_pending_upload",
        "Attachment has no file uploaded yet.",
    ),
    Attachment.STATUS_FAILED: ("attachment_storage_failed", "Attachment storage failed."),
    Attachment.STATUS_TIMED_OUT: ("attachment_storage_timed_out", "Attachment storage timed out."),
}


def _transaction_target_summary(tx: Transaction) -> dict[str, str]:
    summary: dict[str, str] = {"date": tx.transaction_date.isoformat()}
    if tx.payee:
        summary["payee"] = tx.payee
    if tx.narration:
        summary["narration"] = tx.narration
    return summary


def lot_key_for_posting(posting: Posting) -> LotKey | None:
    if posting.cost_per_unit is None or posting.cost_symbol is None:
        return None
    # Guaranteed by _load_transactions_for_doctor's inner join to Account —
    # doctor never calls this with an accountless posting. (Posting.account
    # is statically Account | None because this function is typed against
    # the real ORM class, even though doctor only ever passes it the
    # cast-to-Transaction DTO from that inner-joined query.)
    assert posting.account is not None
    return LotKey(
        account=posting.account.account_name,
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


def build_account_not_effective_issues(
    transactions: Sequence[Transaction],
) -> list[DoctorIssue]:
    issues = []
    for transaction in transactions:
        # `if posting.account is not None` never actually filters anything
        # here — guaranteed by _load_transactions_for_doctor's inner join to
        # Account (see lot_key_for_posting's docstring for why the type is
        # still Account | None regardless).
        accounts_by_id: dict[int, Account] = {
            posting.account.id: posting.account
            for posting in transaction.postings
            if posting.account is not None
        }
        inactive = [
            account.account_name
            for account in accounts_by_id.values()
            if transaction.transaction_date < account.effective_start_date
            or (
                account.effective_end_date is not None
                and transaction.transaction_date > account.effective_end_date
            )
        ]
        if inactive:
            issues.append(
                DoctorIssue(
                    target=transaction.name,
                    target_summary=_transaction_target_summary(transaction),
                    code="account_not_effective",
                    severity="error",
                    message="Transaction references accounts not effective on its date.",
                    details={"accounts": ", ".join(sorted(inactive))},
                )
            )
    return issues


def build_unknown_commodity_issues(
    transactions: Sequence[Transaction],
    known_symbols: set[str],
) -> list[DoctorIssue]:
    issues = []
    for transaction in transactions:
        unknown = sorted(
            {
                symbol
                for posting in transaction.postings
                for symbol in (posting.units_symbol, posting.cost_symbol, posting.price_symbol)
                if symbol is not None and symbol not in known_symbols
            }
        )
        if unknown:
            issues.append(
                DoctorIssue(
                    target=transaction.name,
                    target_summary=_transaction_target_summary(transaction),
                    code="unknown_commodity",
                    severity="error",
                    message="Transaction references commodities that do not exist.",
                    details={"symbols": ", ".join(unknown)},
                )
            )
    return issues


def build_lot_match_missing_issues(
    transactions: Sequence[Transaction],
    booking_method: BookingMethod = BookingMethod.FIFO,
) -> list[DoctorIssue]:
    tx_summaries = {tx.name: _transaction_target_summary(tx) for tx in transactions}
    lot_deltas = transaction_lot_deltas(transactions)
    failures = BookingReplay(booking_method).replay(lot_deltas).failures
    return [
        DoctorIssue(
            target=failure.target,
            target_summary=tx_summaries.get(failure.target, {}),
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
    rows = session.execute(
        select(
            Transaction.id,
            Transaction.name,
            Transaction.transaction_date,
            Transaction.payee,
            Transaction.narration,
            Posting.units_amount,
            Posting.units_symbol,
            Posting.cost_per_unit,
            Posting.cost_symbol,
            Posting.price_per_unit,
            Posting.price_symbol,
            Account.id.label("account_id"),
            Account.account_name,
            Account.effective_start_date,
            Account.effective_end_date,
        )
        .select_from(Transaction)
        .join(Posting, Posting.transaction_id == Transaction.id)
        # Inner join: an accountless posting (Posting.account_id IS NULL,
        # a split's not-yet-categorized remainder) is ignored by doctor
        # entirely until it's categorized — see _PostingData.account
        # docstring. Its transaction still surfaces normally as long as
        # another posting has an account (always true in practice).
        .join(Account, Account.id == Posting.account_id)
        .order_by(Transaction.transaction_date, Transaction.name, Posting.posting_order)
    ).all()

    tx_map: dict[int, _TxData] = {}
    for row in rows:
        if row.id not in tx_map:
            tx_map[row.id] = _TxData(
                id=row.id,
                name=row.name,
                transaction_date=row.transaction_date,
                payee=row.payee,
                narration=row.narration,
            )
        tx_map[row.id].postings.append(
            _PostingData(
                account=_make_account_data(row),
                units_amount=row.units_amount,
                units_symbol=row.units_symbol,
                cost_per_unit=row.cost_per_unit,
                cost_symbol=row.cost_symbol,
                price_per_unit=row.price_per_unit,
                price_symbol=row.price_symbol,
            )
        )
    return cast(list[Transaction], list(tx_map.values()))


def _load_balance_assertions_for_doctor(session: Session) -> list[BalanceAssertion]:
    rows = session.execute(
        select(
            BalanceAssertion.name,
            BalanceAssertion.assertion_date,
            BalanceAssertion.amount,
            BalanceAssertion.symbol,
            Account.id.label("account_id"),
            Account.account_name,
            Account.effective_start_date,
            Account.effective_end_date,
        )
        .select_from(BalanceAssertion)
        .join(Account, Account.id == BalanceAssertion.account_id)
        .order_by(BalanceAssertion.assertion_date, BalanceAssertion.name)
    ).all()
    return cast(
        list[BalanceAssertion],
        [
            _BalanceAssertionData(
                name=row.name,
                assertion_date=row.assertion_date,
                amount=row.amount,
                symbol=row.symbol,
                # BalanceAssertion.account_id is not nullable (unlike
                # Posting.account_id) — this inner join always matches.
                account=_make_account_data(row),
            )
            for row in rows
        ],
    )


def build_attachment_doctor_issues(session: Session) -> list[DoctorIssue]:
    reportable = [
        Attachment.STATUS_PENDING_UPLOAD,
        Attachment.STATUS_FAILED,
        Attachment.STATUS_TIMED_OUT,
    ]
    rows = session.execute(
        select(
            Attachment.name,
            Attachment.attachment_date,
            Attachment.original_filename,
            Attachment.status,
            Account.account_name,
        )
        .select_from(Attachment)
        .join(Account, Account.id == Attachment.account_id)
        .where(Attachment.status.in_(reportable))
        .order_by(Attachment.attachment_date, Attachment.name)
    ).all()
    attachments = [
        _AttachmentData(
            name=row.name,
            attachment_date=row.attachment_date,
            original_filename=row.original_filename,
            status=row.status,
            account_name=row.account_name,
        )
        for row in rows
    ]
    issues: list[DoctorIssue] = []
    for attachment in attachments:
        code, message = _ATTACHMENT_STATUS_INFO[attachment.status]
        issues.append(
            DoctorIssue(
                target=attachment.name,
                target_summary={
                    "date": attachment.attachment_date.isoformat(),
                    "account": attachment.account_name,
                    "filename": attachment.original_filename,
                },
                code=code,
                severity="error",
                message=message,
            )
        )
    return issues


def doctor_ledger(session: Session, request: DoctorLedgerRequest) -> DoctorLedgerResponse:
    del request
    transactions = _load_transactions_for_doctor(session)
    known_symbols: set[str] = set(session.scalars(select(Commodity.symbol)))
    balance_assertion_diffs = compute_balance_assertion_diffs(
        transactions, _load_balance_assertions_for_doctor(session)
    )

    return DoctorLedgerResponse(
        issues=list(
            chain(
                (iss for tx in transactions for iss in build_transaction_unbalanced_issues(tx)),
                build_account_not_effective_issues(transactions),
                build_unknown_commodity_issues(transactions, known_symbols),
                build_lot_match_missing_issues(transactions, booking_method=BookingMethod.FIFO),
                (
                    DoctorIssue(
                        target=diff.balance_assertion,
                        target_summary={
                            "date": diff.assertion_date.isoformat(),
                            "account": diff.account_name,
                        },
                        code="balance_assertion_failed",
                        severity="error",
                        message="Balance assertion not satisfied.",
                        details={
                            "symbol": diff.symbol,
                            "asserted_amount": decimal_to_string(diff.expected),
                            "actual_amount": decimal_to_string(diff.actual),
                            "diff": decimal_to_string(diff.diff),
                            "tolerance": decimal_to_string(tolerance),
                        },
                    )
                    for diff in balance_assertion_diffs
                    for tolerance in [resolve_tolerance(diff.symbol)]
                    if abs(diff.diff) > tolerance
                ),
                build_attachment_doctor_issues(session),
            )
        )
    )
