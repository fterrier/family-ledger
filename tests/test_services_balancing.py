from __future__ import annotations

from datetime import date
from decimal import Decimal

from family_ledger.api.schemas import MoneyValue, PostingPayload, TransactionCreate
from family_ledger.models import Account, Posting, Transaction
from family_ledger.services import balancing


def test_resolve_tolerance_uses_symbol_override() -> None:
    assert balancing.resolve_tolerance("CHF") == Decimal("0.01")


def test_resolve_tolerance_uses_default_when_symbol_missing() -> None:
    assert balancing.resolve_tolerance("EUR") == Decimal("0.000001")


def test_derive_normalize_issues_allows_small_residual_within_tolerance() -> None:
    payload = TransactionCreate(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingPayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-10.005"), symbol="CHF"),
            ),
            PostingPayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("10.00"), symbol="CHF"),
            ),
        ],
    )

    assert balancing.derive_normalize_issues(payload) == []


def test_derive_normalize_issues_reports_residual_outside_default_tolerance() -> None:
    payload = TransactionCreate(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingPayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-10.00001"), symbol="EUR"),
            ),
            PostingPayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("10.00"), symbol="EUR"),
            ),
        ],
    )

    issues = balancing.derive_normalize_issues(payload)

    assert len(issues) == 1
    assert issues[0].details == {
        "symbol": "EUR",
        "residual_amount": "-0.00001",
        "tolerance_amount": "0.000001",
    }


def test_posting_weight_uses_cost_weight_over_price() -> None:
    posting = PostingPayload(
        account="accounts/acc_one",
        units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
        cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
        price=MoneyValue(amount=Decimal("150.00"), symbol="USD"),
    )

    weight = balancing.posting_weight(posting)

    assert weight == MoneyValue(amount=Decimal("500.00"), symbol="USD")


def test_persisted_posting_weight_uses_cost_weight_over_price() -> None:
    transaction = Transaction(name="transactions/txn_one", transaction_date=date(2026, 4, 19))
    account = Account(
        name="accounts/acc_one",
        account_name="Assets:Broker:Stocks",
        effective_start_date=date(2020, 1, 1),
    )
    posting = Posting(
        transaction=transaction,
        account=account,
        posting_order=1,
        units_amount=Decimal("5"),
        units_symbol="GOOG",
        cost_per_unit=Decimal("100.00"),
        cost_symbol="USD",
        price_per_unit=Decimal("150.00"),
        price_symbol="USD",
    )

    weight = balancing.persisted_posting_weight(posting)

    assert weight == MoneyValue(amount=Decimal("500.00"), symbol="USD")


def test_build_transaction_unbalanced_issues_for_persisted_transaction() -> None:
    transaction = Transaction(
        name="transactions/txn_one",
        transaction_date=date(2026, 4, 19),
        postings=[],
    )
    account = Account(
        name="accounts/acc_one",
        account_name="Assets:Bank:Checking:Family",
        effective_start_date=date(2020, 1, 1),
    )
    transaction.postings.extend(
        [
            Posting(
                account=account,
                posting_order=1,
                units_amount=Decimal("-100.00"),
                units_symbol="CHF",
            ),
            Posting(
                account=account,
                posting_order=2,
                units_amount=Decimal("99.00"),
                units_symbol="CHF",
            ),
        ]
    )

    issues = balancing.build_transaction_unbalanced_issues(transaction)

    assert issues == [
        balancing.DoctorIssue(
            target="transactions/txn_one",
            code="transaction_unbalanced",
            severity="error",
            message="Transaction is not balanced within tolerance.",
            details={
                "symbol": "CHF",
                "residual_amount": "-1",
                "tolerance_amount": "0.01",
            },
        )
    ]
