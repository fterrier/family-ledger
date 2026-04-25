from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from family_ledger.api.schemas import (
    MoneyValue,
    NormalizePriceValue,
    PostingNormalizePayload,
    TransactionNormalizeData,
)
from family_ledger.services import normalization
from family_ledger.services.errors import ValidationError


def test_normalize_transaction_uses_price_when_cost_absent() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("1000.00"), symbol="USD"),
                price=MoneyValue(amount=Decimal("0.92"), symbol="CHF"),
            ),
            PostingNormalizePayload(account="accounts/acc_two"),
        ],
    )

    normalized = normalization.normalize_transaction_payload(payload)

    assert normalized.postings[1].units is not None
    assert normalized.postings[1].units.amount == Decimal("-920.00")
    assert normalized.postings[1].units.symbol == "CHF"


def test_normalize_transaction_uses_cost_when_present() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
                cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
            ),
            PostingNormalizePayload(account="accounts/acc_two"),
        ],
    )

    normalized = normalization.normalize_transaction_payload(payload)

    assert normalized.postings[1].units is not None
    assert normalized.postings[1].units.amount == Decimal("-500.00")
    assert normalized.postings[1].units.symbol == "USD"


def test_normalize_transaction_rejects_cost_price_symbol_mismatch() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
                cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                price=MoneyValue(amount=Decimal("150.00"), symbol="CHF"),
            ),
            PostingNormalizePayload(account="accounts/acc_two"),
        ],
    )

    with pytest.raises(ValidationError) as exc_info:
        normalization.normalize_transaction_payload(payload)

    assert exc_info.value.code == "cost_price_symbol_mismatch"


def test_normalize_transaction_expands_multi_symbol_weights() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-95.65"), symbol="CHF"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("20.00"), symbol="EUR"),
            ),
            PostingNormalizePayload(account="accounts/acc_three"),
        ],
    )

    normalized = normalization.normalize_transaction_payload(payload)

    assert len(normalized.postings) == 4
    inferred = normalized.postings[2:]
    assert inferred[0].units is not None and inferred[0].units == MoneyValue(
        amount=Decimal("95.65"), symbol="CHF"
    )
    assert inferred[1].units is not None and inferred[1].units == MoneyValue(
        amount=Decimal("-20.00"), symbol="EUR"
    )


def test_zero_weight_posting_does_not_create_ambiguity() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("0"), symbol="ESGV"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("89.35"), symbol="USD"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_three",
                units=MoneyValue(amount=Decimal("15.77"), symbol="USD"),
            ),
            PostingNormalizePayload(account="accounts/acc_four"),
        ],
    )

    normalized = normalization.normalize_transaction_payload(payload)

    inferred = normalized.postings[-1]
    assert inferred.units is not None
    assert inferred.units.amount == Decimal("-105.12")
    assert inferred.units.symbol == "USD"


def test_normalize_transaction_interpolates_missing_price_amount() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-22.80"), symbol="CHF"),
                price=MoneyValue(amount=Decimal("0.997999"), symbol="USD"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("1.30"), symbol="CHF"),
                price=NormalizePriceValue(symbol="USD"),
            ),
        ],
    )

    normalized = normalization.normalize_transaction_payload(payload)

    assert normalized.postings[1].price is not None
    assert normalized.postings[1].price.amount == Decimal("17.50336707692307692307692308")
