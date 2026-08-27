"""Integration tests: value() and convert(value(...)) must agree with real
beancount/beanquery on the exact scenarios these functions depend on.
Unlike the unit tests in test_services_query_executor.py (which test our
own executor in isolation), these build the *same* ledger twice — once as
ORM fixtures for our own engine, once as beancount source text — and run
an equivalent BQL query against each, via the real `beanquery` package
(already a project dependency; see pyproject.toml). Both queries omit an
explicit date, so both fall back to "today" identically — no need to
synchronize a fixed comparison date between the two engines.

See services/prices.py's ValuePriceLookup docstring for value()'s fidelity
to beancount's get_value(): a price recorded in the *wrong* currency
(relative to a lot's own cost currency) must never be substituted — the
reason for grouping by (units_symbol, value_currency) instead of by symbol
alone.
"""

from __future__ import annotations

from decimal import Decimal

import beancount.loader as bc_loader
from beanquery import query as bc_query
from query_helpers import build_session

from family_ledger.services.query.executor import execute_query

Amounts = list[tuple[str, Decimal]]


def _our_value(transactions: list, prices: tuple, account: str) -> Amounts:
    session = build_session(transactions, prices)
    result = execute_query(session, f"SELECT value(sum(position)) AS v WHERE account = '{account}'")
    if not result.rows:
        return []
    inventory = result.rows[0][0]
    return sorted((cell["currency"], Decimal(cell["number"])) for cell in inventory)


def _beancount_value(text: str, account: str) -> Amounts:
    entries, errors, options = bc_loader.load_string(text)
    assert not errors, errors
    _, rows = bc_query.run_query(
        entries, options, f"SELECT value(sum(position)) WHERE account = '{account}'"
    )
    if not rows or rows[0][0] is None:
        return []
    return sorted((position.units.currency, position.units.number) for position in rows[0][0])


def test_priced_security_matches_beancount() -> None:
    account = "Assets:Broker:VSS"
    our = _our_value(
        [
            (
                "2020-01-01",
                [
                    (account, "100", "VSS", {"cost_amount": "40.00", "cost_symbol": "CAD"}),
                    ("Equity:Opening", "-4000", "CAD"),
                ],
            )
        ],
        (("2025-07-10", "VSS", "CAD", "45.00"),),
        account,
    )
    beancount = _beancount_value(
        """
2020-01-01 open Assets:Broker:VSS
2020-01-01 open Equity:Opening

2020-01-01 * "buy"
  Assets:Broker:VSS   100 VSS {40.00 CAD}
  Equity:Opening     -4000 CAD

2025-07-10 price VSS  45.00 CAD
""",
        account,
    )
    assert our == beancount == [("CAD", Decimal("4500.00"))]


def test_price_in_wrong_currency_passes_through_on_both_engines() -> None:
    # The whole reason value() groups by (units_symbol, value_currency)
    # instead of symbol alone: a VSS price quoted in USD must not be used to
    # revalue a lot costed in CAD, even though it's the only price on file.
    account = "Assets:Broker:VSS"
    our = _our_value(
        [
            (
                "2020-01-01",
                [
                    (account, "100", "VSS", {"cost_amount": "40.00", "cost_symbol": "CAD"}),
                    ("Equity:Opening", "-4000", "CAD"),
                ],
            )
        ],
        (("2025-07-10", "VSS", "USD", "30.00"),),
        account,
    )
    beancount = _beancount_value(
        """
2020-01-01 open Assets:Broker:VSS
2020-01-01 open Equity:Opening

2020-01-01 * "buy"
  Assets:Broker:VSS   100 VSS {40.00 CAD}
  Equity:Opening     -4000 CAD

2025-07-10 price VSS  30.00 USD
""",
        account,
    )
    assert our == beancount == [("VSS", Decimal("100"))]


def test_no_price_at_all_passes_through_on_both_engines() -> None:
    account = "Assets:Broker:XYZ"
    our = _our_value(
        [
            (
                "2020-01-02",
                [
                    (account, "10", "XYZ", {"cost_amount": "5.00", "cost_symbol": "EUR"}),
                    ("Equity:Opening", "-50", "EUR"),
                ],
            )
        ],
        (),
        account,
    )
    beancount = _beancount_value(
        """
2020-01-01 open Assets:Broker:XYZ
2020-01-01 open Equity:Opening

2020-01-02 * "buy, never priced"
  Assets:Broker:XYZ   10 XYZ {5.00 EUR}
  Equity:Opening     -50 EUR
""",
        account,
    )
    assert our == beancount == [("XYZ", Decimal("10"))]


def test_zero_priced_entry_matches_beancount() -> None:
    # A stored 0 price is used literally, same as beancount — a security
    # legitimately can devalue to nothing (a multi-lot holding with a
    # genuine total loss, confirmed directly against
    # beancount.core.convert.get_value). The revalued 0 then drops out of
    # both engines' results, same as any other zero balance.
    account = "Assets:Broker:FARMY"
    transactions = [
        (
            "2022-11-02",
            [
                (account, "200", "FARMY", {"cost_amount": "11.99", "cost_symbol": "CHF"}),
                ("Equity:Opening", "-2398", "CHF"),
            ],
        ),
        (
            "2023-06-30",
            [
                (account, "188", "FARMY", {"cost_amount": "2.65", "cost_symbol": "CHF"}),
                ("Equity:Opening", "-498.20", "CHF"),
            ],
        ),
    ]
    prices = (
        ("2023-06-06", "FARMY", "CHF", "2.64"),
        ("2025-01-31", "FARMY", "CHF", "0"),
    )
    our = _our_value(transactions, prices, account)
    beancount = _beancount_value(
        """
2020-01-01 open Assets:Broker:FARMY
2020-01-01 open Equity:Opening

2022-11-02 * "buy"
  Assets:Broker:FARMY   200 FARMY {11.99 CHF}
  Equity:Opening       -2398.00 CHF

2023-06-30 * "buy"
  Assets:Broker:FARMY   188 FARMY {2.65 CHF}
  Equity:Opening       -498.20 CHF

2023-06-06 price FARMY 2.64 CHF
2025-01-31 price FARMY 0 CHF
""",
        account,
    )
    assert our == beancount == []


def test_plain_currency_never_held_at_cost_passes_through_on_both_engines() -> None:
    account = "Assets:Cash:CHF"
    our = _our_value(
        [("2020-01-03", [(account, "300", "CHF"), ("Equity:Opening", "-300", "CHF")])],
        (),
        account,
    )
    beancount = _beancount_value(
        """
2020-01-01 open Assets:Cash:CHF
2020-01-01 open Equity:Opening

2020-01-03 * "plain currency"
  Assets:Cash:CHF   300 CHF
  Equity:Opening   -300 CHF
""",
        account,
    )
    assert our == beancount == [("CHF", Decimal("300"))]


def _our_converted_value(
    transactions: list, prices: tuple, account: str, target: str
) -> tuple[str, Decimal] | None:
    session = build_session(transactions, prices)
    result = execute_query(
        session,
        f"SELECT convert(value(sum(position)), '{target}') AS v WHERE account = '{account}'",
    )
    cell = result.rows[0][0] if result.rows else None
    return None if cell is None else (cell["currency"], Decimal(cell["number"]))


def _beancount_converted_value(text: str, account: str, target: str) -> tuple[str, Decimal] | None:
    entries, errors, options = bc_loader.load_string(text)
    assert not errors, errors
    _, rows = bc_query.run_query(
        entries,
        options,
        f"SELECT convert(value(sum(position)), '{target}') WHERE account = '{account}'",
    )
    inventory = rows[0][0] if rows else None
    if inventory is None or inventory.is_empty():
        return None
    positions = list(inventory)
    assert len(positions) == 1, positions
    return positions[0].units.currency, positions[0].units.number


def test_convert_of_value_matches_beancount() -> None:
    # convert(value(x), 'CUR') is exactly real bean-query's own composition
    # pattern for "market value in a specific display currency" — revalue
    # at market price, then FX-convert the result.
    account = "Assets:Broker:VSS"
    our = _our_converted_value(
        [
            (
                "2025-07-05",
                [
                    (account, "10", "VSS", {"cost_amount": "40.00", "cost_symbol": "USD"}),
                    ("Equity:Opening", "-400.00", "USD"),
                ],
            )
        ],
        (
            ("2025-07-10", "VSS", "USD", "45.00"),
            ("2025-07-10", "USD", "CHF", "0.80"),
        ),
        account,
        "CHF",
    )
    beancount = _beancount_converted_value(
        """
2020-01-01 open Assets:Broker:VSS
2020-01-01 open Equity:Opening

2025-07-05 * "buy"
  Assets:Broker:VSS   10 VSS {40.00 USD}
  Equity:Opening     -400.00 USD

2025-07-10 price VSS 45.00 USD
2025-07-10 price USD 0.80 CHF
""",
        account,
        "CHF",
    )
    assert our == beancount == ("CHF", Decimal("360.00"))
