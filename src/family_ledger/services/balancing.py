from __future__ import annotations

from decimal import Decimal

from family_ledger.api.schemas import (
    DoctorIssue,
    MoneyValue,
    NormalizeIssue,
    PostingNormalizePayload,
    PostingPayload,
    TransactionData,
)
from family_ledger.config import get_ledger_config
from family_ledger.models import Posting, Transaction
from family_ledger.services.errors import ValidationError


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
    if posting.cost is not None:
        return MoneyValue(
            amount=posting.units.amount * posting.cost.amount,
            symbol=posting.cost.symbol,
        )
    if posting.price is not None and posting.price.amount is not None:
        return MoneyValue(
            amount=posting.units.amount * posting.price.amount,
            symbol=posting.price.symbol,
        )
    return MoneyValue(amount=posting.units.amount, symbol=posting.units.symbol)


def persisted_posting_weight(posting: Posting) -> MoneyValue:
    if posting.cost_per_unit is not None:
        assert posting.cost_symbol is not None
        return MoneyValue(
            amount=posting.units_amount * posting.cost_per_unit,
            symbol=posting.cost_symbol,
        )
    if posting.price_per_unit is not None:
        assert posting.price_symbol is not None
        return MoneyValue(
            amount=posting.units_amount * posting.price_per_unit,
            symbol=posting.price_symbol,
        )
    return MoneyValue(amount=posting.units_amount, symbol=posting.units_symbol)


def transaction_balance_totals_by_symbol(
    postings: list[PostingPayload] | list[PostingNormalizePayload],
) -> dict[str, Decimal]:
    totals: dict[str, Decimal] = {}
    for posting in postings:
        weight = posting_weight(posting)
        if weight is None or weight.amount == 0:
            continue
        totals[weight.symbol] = totals.get(weight.symbol, Decimal("0")) + weight.amount
    return totals


def resolve_tolerance(symbol: str) -> Decimal:
    config = get_ledger_config()
    return config.tolerance.get(symbol, config.default_tolerance)


def decimal_to_string(value: Decimal) -> str:
    normalized = value.normalize()
    return format(normalized, "f")


def build_transaction_unbalanced_issues(
    transaction: Transaction,
) -> list[DoctorIssue]:
    totals: dict[str, Decimal] = {}
    for posting in transaction.postings:
        weight = persisted_posting_weight(posting)
        if weight.amount == 0:
            continue
        totals[weight.symbol] = totals.get(weight.symbol, Decimal("0")) + weight.amount

    issues: list[DoctorIssue] = []
    for symbol, amount in sorted(totals.items()):
        tolerance = resolve_tolerance(symbol)
        if abs(amount) <= tolerance:
            continue
        issues.append(
            DoctorIssue(
                target=transaction.name,
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


def derive_normalize_issues(payload: TransactionData) -> list[NormalizeIssue]:
    totals = transaction_balance_totals_by_symbol(payload.postings)
    issues: list[NormalizeIssue] = []
    for symbol, amount in sorted(totals.items()):
        tolerance = resolve_tolerance(symbol)
        if abs(amount) <= tolerance:
            continue
        issues.append(
            NormalizeIssue(
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
