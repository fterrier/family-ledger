"""Unit tests for PriceLookup (services/prices.py), independent of its two
callers (the reporting query executor and the transactions list's `convert`
view) — see docs/specs/reporting-query.md for the conversion contract this
implements: latest price on or before the date, direct pair, then inverse,
then a single intermediate hop.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from query_helpers import build_session

from family_ledger.services.prices import PriceLookup

# Each row: (price_date, base_symbol, quote_symbol, price_per_unit).
Prices = tuple[tuple[str, str, str, str], ...]


def _lookup(prices: Prices, target: str, latest: date) -> PriceLookup:
    session = build_session([], prices)
    currencies = {base for _, base, _, _ in prices} | {quote for _, _, quote, _ in prices}
    return PriceLookup(session, currencies, target, latest)


def test_direct_pair_rate() -> None:
    lookup = _lookup((("2025-07-10", "USD", "CHF", "0.85"),), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) == Decimal("0.85")


def test_inverse_pair_rate() -> None:
    # Only CHF->USD is stored; converting USD->CHF must use the inverse.
    lookup = _lookup((("2025-07-10", "CHF", "USD", "1.25"),), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) == Decimal(1) / Decimal("1.25")


def test_no_price_path_returns_none() -> None:
    lookup = _lookup((), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) is None


def test_zero_priced_direct_entry_is_not_used_as_a_rate() -> None:
    # A stored 0 is degenerate data (a real price is never actually zero);
    # treating it as a real rate would silently convert everything to 0.
    lookup = _lookup((("2025-07-10", "USD", "CHF", "0"),), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) is None


def test_zero_priced_direct_entry_falls_back_to_an_earlier_real_price() -> None:
    lookup = _lookup(
        (
            ("2025-06-01", "USD", "CHF", "0.85"),
            ("2025-07-10", "USD", "CHF", "0"),
        ),
        "CHF",
        date(2025, 8, 1),
    )
    assert lookup.rate("USD", date(2025, 8, 1)) == Decimal("0.85")


def test_zero_priced_inverse_entry_does_not_raise_division_by_zero() -> None:
    # Regression: inverting a stored 0 rate (1 / 0) used to raise
    # decimal.DivisionByZero and turn the request into a 500.
    lookup = _lookup((("2025-07-10", "CHF", "USD", "0"),), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) is None


def test_zero_priced_inverse_entry_falls_back_to_an_earlier_real_price() -> None:
    lookup = _lookup(
        (
            ("2025-06-01", "CHF", "USD", "1.25"),
            ("2025-07-10", "CHF", "USD", "0"),
        ),
        "CHF",
        date(2025, 8, 1),
    )
    assert lookup.rate("USD", date(2025, 8, 1)) == Decimal(1) / Decimal("1.25")


def test_transitive_hop_skips_a_zero_priced_intermediate_leg() -> None:
    # GBP is only priced in USD, and that single USD->CHF leg is zero —
    # the transitive path has nothing usable, so this must return None,
    # not raise or silently return a zero-derived rate.
    lookup = _lookup(
        (
            ("2025-06-01", "GBP", "USD", "1.10"),
            ("2025-06-01", "USD", "CHF", "0"),
        ),
        "CHF",
        date(2025, 8, 1),
    )
    assert lookup.rate("GBP", date(2025, 8, 1)) is None


def test_rate_only_considers_prices_on_or_before_the_date() -> None:
    lookup = _lookup(
        (
            ("2025-07-10", "USD", "CHF", "0.85"),
            ("2025-08-10", "USD", "CHF", "0.80"),
        ),
        "CHF",
        date(2025, 8, 10),
    )
    assert lookup.rate("USD", date(2025, 7, 31)) == Decimal("0.85")
