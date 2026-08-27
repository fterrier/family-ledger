"""Unit tests for PriceLookup (services/prices.py), independent of its two
callers (the reporting query executor and the transactions list's `convert`
view) — see docs/specs/reporting-query.md for the conversion contract this
implements: latest price on or before the date, direct pair only (no
inversion), then a single intermediate hop. A stored 0 is used literally,
same as ValuePriceLookup — see both classes' docstrings for why neither
special-cases 0 (Commodity/Price have no field distinguishing a currency
from a security, so there's no principled basis for the two lookups to
disagree).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from query_helpers import build_session

from family_ledger.services.prices import PriceLookup, ValuePriceLookup

# Each row: (price_date, base_symbol, quote_symbol, price_per_unit).
Prices = tuple[tuple[str, str, str, str], ...]


def _lookup(prices: Prices, target: str, latest: date) -> PriceLookup:
    session = build_session([], prices)
    currencies = {base for _, base, _, _ in prices} | {quote for _, _, quote, _ in prices}
    return PriceLookup(session, currencies, target, latest)


def test_direct_pair_rate() -> None:
    lookup = _lookup((("2025-07-10", "USD", "CHF", "0.85"),), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) == Decimal("0.85")


def test_inverse_pair_does_not_resolve() -> None:
    # Only CHF->USD is stored; a price must be recorded in the direction
    # it's needed — PriceLookup does not invert a stored pair to resolve
    # the reverse direction.
    lookup = _lookup((("2025-07-10", "CHF", "USD", "1.25"),), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) is None


def test_no_price_path_returns_none() -> None:
    lookup = _lookup((), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) is None


def test_zero_priced_direct_entry_is_used_literally() -> None:
    # A security's price legitimately can be 0 (total loss, delisting) —
    # Commodity/Price have no field distinguishing a currency from a
    # security, so an FX rate is treated the same way as ValuePriceLookup
    # treats a security's price: a stored 0 is real information, not
    # degenerate data to skip past.
    lookup = _lookup((("2025-07-10", "USD", "CHF", "0"),), "CHF", date(2025, 8, 1))
    assert lookup.rate("USD", date(2025, 8, 1)) == Decimal("0")


def test_transitive_hop_uses_a_zero_priced_intermediate_leg_literally() -> None:
    # GBP is only priced in USD, and that single USD->CHF leg is zero — the
    # hop still resolves, at a literal (real, if unfortunate) rate of 0.
    lookup = _lookup(
        (
            ("2025-06-01", "GBP", "USD", "1.10"),
            ("2025-06-01", "USD", "CHF", "0"),
        ),
        "CHF",
        date(2025, 8, 1),
    )
    assert lookup.rate("GBP", date(2025, 8, 1)) == Decimal("0")


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


# ---------------------------------------------------------------------------
# ValuePriceLookup: a single direct (base, quote) hop, no chaining, no
# inversion — see its docstring for why this must stay narrower than
# PriceLookup (beancount's get_value() semantics).
# ---------------------------------------------------------------------------


def _value_lookup(prices: Prices, latest: date) -> ValuePriceLookup:
    session = build_session([], prices)
    symbols = {base for _, base, _, _ in prices}
    return ValuePriceLookup(session, symbols, latest)


def test_value_lookup_direct_pair_price() -> None:
    lookup = _value_lookup((("2025-07-10", "VSS", "CAD", "40.00"),), date(2025, 8, 1))
    assert lookup.price("VSS", "CAD", date(2025, 8, 1)) == Decimal("40.00")


def test_value_lookup_does_not_invert_a_reversed_pair() -> None:
    # Neither lookup inverts (see PriceLookup's own equivalent test) — a
    # CAD->VSS price is not a valid substitute for a VSS->CAD lookup.
    lookup = _value_lookup((("2025-07-10", "CAD", "VSS", "0.025"),), date(2025, 8, 1))
    assert lookup.price("VSS", "CAD", date(2025, 8, 1)) is None


def test_value_lookup_does_not_chain_through_an_intermediate() -> None:
    # VSS is only priced in USD, and the query asks for it in CAD — no
    # single-hop fallback via USD, unlike PriceLookup's FX chaining.
    lookup = _value_lookup(
        (
            ("2025-07-10", "VSS", "USD", "30.00"),
            ("2025-07-10", "USD", "CAD", "1.35"),
        ),
        date(2025, 8, 1),
    )
    assert lookup.price("VSS", "CAD", date(2025, 8, 1)) is None


def test_value_lookup_no_price_returns_none() -> None:
    lookup = _value_lookup((), date(2025, 8, 1))
    assert lookup.price("VSS", "CAD", date(2025, 8, 1)) is None


def test_value_lookup_zero_priced_entry_is_used_literally() -> None:
    # A security's price legitimately can be 0 (total loss, delisting) —
    # that's real information, not degenerate data to skip past.
    lookup = _value_lookup(
        (
            ("2025-06-01", "VSS", "CAD", "38.00"),
            ("2025-07-10", "VSS", "CAD", "0"),
        ),
        date(2025, 8, 1),
    )
    assert lookup.price("VSS", "CAD", date(2025, 8, 1)) == Decimal("0")


def test_value_lookup_only_considers_prices_on_or_before_the_date() -> None:
    lookup = _value_lookup(
        (
            ("2025-07-10", "VSS", "CAD", "40.00"),
            ("2025-08-10", "VSS", "CAD", "45.00"),
        ),
        date(2025, 8, 10),
    )
    assert lookup.price("VSS", "CAD", date(2025, 7, 31)) == Decimal("40.00")
