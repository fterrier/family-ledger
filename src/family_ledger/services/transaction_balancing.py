from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.sql import ColumnElement

from family_ledger.api.schemas import (
    DoctorIssue,
    MoneyValue,
    PostingNormalizePayload,
    PostingPayload,
)
from family_ledger.config import get_ledger_config
from family_ledger.models import Posting, Transaction
from family_ledger.services.errors import ValidationError


def weight_symbol_column() -> ColumnElement:
    """SQL equivalent of persisted_posting_weight's currency (cost, then
    price, then raw units) — kept next to _compute_weight so the two
    definitions of "weight" can't silently drift. Used by the query
    compiler to make sum(position)/last(balance) convert via a posting's
    weight instead of its raw units (see services/query/compiler.py)."""
    return func.coalesce(Posting.cost_symbol, Posting.price_symbol, Posting.units_symbol)


def weight_amount_column() -> ColumnElement:
    """SQL equivalent of persisted_posting_weight's amount: cost_per_unit or
    price_per_unit as the multiplier, or a no-op 1 for a plain posting —
    same coalesce priority as weight_symbol_column."""
    return Posting.units_amount * func.coalesce(Posting.cost_per_unit, Posting.price_per_unit, 1)


def _compute_weight(
    units_amount: Decimal,
    units_symbol: str,
    cost_amount: Decimal | None,
    cost_symbol: str | None,
    price_amount: Decimal | None,
    price_symbol: str | None,
) -> MoneyValue:
    if cost_amount is not None:
        assert cost_symbol is not None
        return MoneyValue(amount=units_amount * cost_amount, symbol=cost_symbol)
    if price_amount is not None:
        assert price_symbol is not None
        return MoneyValue(amount=units_amount * price_amount, symbol=price_symbol)
    return MoneyValue(amount=units_amount, symbol=units_symbol)


def posting_weight(posting: PostingPayload | PostingNormalizePayload) -> MoneyValue | None:
    if posting.units is None or posting.units.symbol is None:
        return None
    if (
        posting.cost is not None
        and posting.price is not None
        and posting.price.amount is not None
        and posting.cost.symbol != posting.price.symbol
    ):
        raise ValidationError(
            code="cost_price_symbol_mismatch",
            message="Postings with both cost and price must use the same symbol.",
        )
    return _compute_weight(
        units_amount=posting.units.amount,
        units_symbol=posting.units.symbol,
        cost_amount=posting.cost.amount if posting.cost is not None else None,
        cost_symbol=posting.cost.symbol if posting.cost is not None else None,
        price_amount=posting.price.amount if posting.price is not None else None,
        price_symbol=posting.price.symbol if posting.price is not None else None,
    )


def persisted_posting_weight(posting: Posting) -> MoneyValue:
    return _compute_weight(
        units_amount=posting.units_amount,
        units_symbol=posting.units_symbol,
        cost_amount=posting.cost_per_unit,
        cost_symbol=posting.cost_symbol,
        price_amount=posting.price_per_unit,
        price_symbol=posting.price_symbol,
    )


def _accumulate_totals(weights: Iterable[MoneyValue | None]) -> dict[str, Decimal]:
    totals: dict[str, Decimal] = {}
    for weight in weights:
        if weight is None or weight.amount == 0:
            continue
        totals[weight.symbol] = totals.get(weight.symbol, Decimal("0")) + weight.amount
    return totals


def transaction_balance_totals_by_symbol(
    postings: list[PostingPayload] | list[PostingNormalizePayload],
) -> dict[str, Decimal]:
    # Accountless postings (a split's not-yet-categorized remainder) are
    # deliberately excluded from balance computation — a transaction with an
    # accounted -100 and an accountless +100 is still unbalanced by 100.
    return _accumulate_totals(posting_weight(p) for p in postings if p.account is not None)


def resolve_tolerance(symbol: str) -> Decimal:
    config = get_ledger_config()
    return config.tolerance.get(symbol, config.default_tolerance)


def decimal_to_string(value: Decimal) -> str:
    normalized = value.normalize()
    return format(normalized, "f")


def _build_unbalanced_issues(
    totals: dict[str, Decimal],
    target: str | None = None,
    target_summary: dict[str, str] | None = None,
) -> list[DoctorIssue]:
    issues: list[DoctorIssue] = []
    for symbol, amount in sorted(totals.items()):
        tolerance = resolve_tolerance(symbol)
        if abs(amount) <= tolerance:
            continue
        issues.append(
            DoctorIssue(
                target=target,
                target_summary=target_summary or {},
                code="transaction_unbalanced",
                severity="error",
                message="Transaction is not balanced within tolerance.",
                details={
                    "symbol": symbol,
                    "residual_amount": decimal_to_string(amount),
                    "tolerance_amount": decimal_to_string(tolerance),
                },
            )
        )
    return issues


def build_transaction_unbalanced_issues(
    transaction: Transaction,
) -> list[DoctorIssue]:
    summary: dict[str, str] = {"date": transaction.transaction_date.isoformat()}
    if transaction.payee:
        summary["payee"] = transaction.payee
    if transaction.narration:
        summary["narration"] = transaction.narration
    # Same accountless exclusion as transaction_balance_totals_by_symbol
    # above, applied to persisted postings.
    totals = _accumulate_totals(
        persisted_posting_weight(p) for p in transaction.postings if p.account is not None
    )
    return _build_unbalanced_issues(totals, target=transaction.name, target_summary=summary)


def _residuals_from_totals(totals: dict[str, Decimal]) -> list[MoneyValue]:
    """Per-symbol gaps as postings, not issues — negated so appending one
    to a postings list makes the transaction balance in that symbol. Mirrors
    _build_unbalanced_issues's tolerance loop and sort order."""
    residuals: list[MoneyValue] = []
    for symbol, amount in sorted(totals.items()):
        tolerance = resolve_tolerance(symbol)
        if abs(amount) <= tolerance:
            continue
        residuals.append(MoneyValue(amount=-amount, symbol=symbol))
    return residuals


def compute_full_balance_residuals_for_payload(
    postings: list[PostingPayload] | list[PostingNormalizePayload],
) -> list[MoneyValue]:
    """Unlike transaction_balance_totals_by_symbol/build_transaction_unbalanced_issues,
    this sums every posting including accountless ones — "is anything
    structurally missing", not "still needs categorizing". A postings list
    already balanced overall (e.g. an accounted posting fully offset by an
    explicit accountless one) returns no residual here, even though it would
    still report a doctor issue. Used by persist_transaction to decide
    whether a balancing filler posting needs to be stored, and by
    normalize_transaction to preview one without storing anything."""
    totals = _accumulate_totals(posting_weight(p) for p in postings)
    return _residuals_from_totals(totals)
