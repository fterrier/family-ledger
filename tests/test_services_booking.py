from __future__ import annotations

from decimal import Decimal

from family_ledger.services.booking import BookingMethod, BookingReplay, LotKey, TransactionLotDelta


def make_lot_key() -> LotKey:
    return LotKey(
        account="accounts/acc_one",
        units_symbol="GOOG",
        cost_symbol="USD",
        cost_per_unit=Decimal("100.00"),
    )


def replay(amounts: list[str]) -> tuple[list, list[Decimal]]:
    lot_key = make_lot_key()
    result = BookingReplay(BookingMethod.FIFO).replay(
        {
            lot_key: [
                TransactionLotDelta(
                    transaction_name=f"transactions/txn_{index}", amount=Decimal(amount)
                )
                for index, amount in enumerate(amounts, start=1)
            ]
        }
    )
    return result.failures, result.open_lots_by_key[lot_key]


def test_fifo_allows_exact_offset_from_multiple_prior_lots() -> None:
    failures, open_lots = replay(["5", "5", "-10"])

    assert failures == []
    assert open_lots == []


def test_fifo_allows_exact_offset_from_multiple_negative_lots() -> None:
    failures, open_lots = replay(["-5", "-5", "10"])

    assert failures == []
    assert open_lots == []


def test_fifo_allows_partial_match_without_failure() -> None:
    failures, open_lots = replay(["5", "5", "-7"])

    assert failures == []
    assert open_lots == [Decimal("3")]


def test_fifo_reports_shortage_after_partial_match() -> None:
    failures, open_lots = replay(["5", "5", "-7", "-7"])

    assert len(failures) == 1
    assert failures[0].requested_amount == Decimal("7")
    assert failures[0].available_amount == Decimal("3")
    assert open_lots == [Decimal("-4")]


def test_fifo_handles_same_side_negative_accumulation() -> None:
    failures, open_lots = replay(["-2", "-1", "3"])

    assert failures == []
    assert open_lots == []


def test_fifo_handles_same_side_positive_accumulation() -> None:
    failures, open_lots = replay(["0.1150", "0.0580", "-0.1730"])

    assert failures == []
    assert open_lots == []
