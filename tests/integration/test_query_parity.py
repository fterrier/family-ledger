"""Parity between POST /ledger:query and real BQL (beanquery) on the export.

Round trip: beancount fixture -> importer -> Postgres -> export_beancount ->
beanquery. The same ledger is then queried through both engines and results
are compared. Where our subset matches BQL exactly, the identical query
string runs on both sides; running-balance buckets are cross-checked against
BQL's `FROM OPEN ON ... CLOSE ON ...` window sums, which is the semantic our
seed + accumulation implements.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import beanquery
import pytest
from beancount import loader
from beancount.core.inventory import Inventory
from fastapi.testclient import TestClient

from family_ledger.config import get_ledger_config
from family_ledger.scripts.export_beancount import export_beancount

pytestmark = pytest.mark.integration

# Edge cases: multi-currency subtree, sub-account, boundary account (ZKBX must
# never match the ZKB subtree), a gap month (September has no ZKB activity),
# an EUR pair only quoted in the inverse direction, and multiple USD prices.
PARITY_LEDGER = """
option "operating_currency" "CHF"

2020-01-01 open Assets:Checking:ZKB
2020-01-01 open Assets:Checking:ZKB:Sub
2020-01-01 open Assets:Checking:ZKBX
2020-01-01 open Assets:Invested:VT
2020-01-01 open Equity:Opening
2020-01-01 open Expenses:Groceries
2020-01-01 open Expenses:Rent
2020-01-01 open Income:Salary
2020-01-01 commodity CHF
2020-01-01 commodity USD
2020-01-01 commodity EUR
2020-01-01 commodity VT

2025-05-10 * "Opening balance"
  Assets:Checking:ZKB    1000 CHF
  Equity:Opening        -1000 CHF

2025-07-05 * "Employer" "Salary"
  Assets:Checking:ZKB    5000 CHF
  Income:Salary         -5000 CHF

2025-07-20 * "Migros" "Groceries"
  Expenses:Groceries      200 CHF
  Assets:Checking:ZKB    -200 CHF

2025-08-03 * "Coop" "Groceries"
  Expenses:Groceries      300 CHF
  Assets:Checking:ZKB    -300 CHF

2025-08-15 * "USD arrival"
  Assets:Checking:ZKB:Sub   50 USD
  Equity:Opening           -50 USD

2025-08-20 * "Landlord" "Rent"
  Expenses:Rent          1500 CHF
  Assets:Checking:ZKB   -1500 CHF

2025-09-01 * "Boundary account activity"
  Assets:Checking:ZKBX    999 CHF
  Equity:Opening         -999 CHF

2025-10-05 * "EUR arrival"
  Assets:Checking:ZKB:Sub   10 EUR
  Equity:Opening           -10 EUR

2025-10-10 * "Buy VT"
  Assets:Invested:VT    5 VT {100.00 USD}
  Equity:Opening    -500.00 USD

2025-07-10 price USD 0.85 CHF
2025-08-10 price USD 0.80 CHF
2025-09-30 price CHF 1.25 EUR
2025-10-01 price VT 100.00 USD
"""

ZKB_SUBTREE = "account ~ '^Assets:Checking:ZKB(:|$)'"


@pytest.fixture
def bql_connection(integration_client, integration_session):
    response = integration_client.post(
        "/importers/beancount:import",
        files={"ledger_file": ("ledger.beancount", PARITY_LEDGER.encode(), "text/plain")},
    )
    assert response.status_code == 200, response.text

    exported = export_beancount(integration_session, get_ledger_config())
    entries, errors, options = loader.load_string(exported)
    assert not errors, errors
    return beanquery.connect("beancount:", entries=entries, errors=errors, options=options)


# ---------------------------------------------------------------------------
# Normalization: both engines' cells -> comparable python values
# ---------------------------------------------------------------------------


def _api_cell(cell: Any) -> Any:
    if isinstance(cell, list):  # inventory
        return {entry["currency"]: Decimal(entry["number"]) for entry in cell}
    if isinstance(cell, dict):  # amount
        return {cell["currency"]: Decimal(cell["number"])}
    return cell


def _bql_cell(cell: Any) -> Any:
    if isinstance(cell, Inventory):
        return {
            position.units.currency: Decimal(position.units.number)
            for position in cell
            if position.units.number is not None
        }
    return cell


def api_rows(client: TestClient, sql: str) -> list[tuple[Any, ...]]:
    response = client.post("/ledger:query", json={"query": sql})
    assert response.status_code == 200, response.text
    return [tuple(_api_cell(cell) for cell in row) for row in response.json()["rows"]]


def bql_rows(connection, sql: str) -> list[tuple[Any, ...]]:
    cursor = connection.execute(sql)
    return [tuple(_bql_cell(cell) for cell in row) for row in cursor.fetchall()]


# ---------------------------------------------------------------------------
# Parity checks
# ---------------------------------------------------------------------------


def test_monthly_expense_sums_match(integration_client, bql_connection) -> None:
    shared = (
        "SELECT year(date) AS y, month(date) AS m, sum(position) AS total"
        " WHERE account ~ '^Expenses:Groceries(:|$)' GROUP BY y, m"
    )
    ours = api_rows(integration_client, shared)
    bql = bql_rows(bql_connection, shared + " ORDER BY y, m")
    assert ours == bql
    assert ours == [
        (2025, 7, {"CHF": Decimal("200")}),
        (2025, 8, {"CHF": Decimal("300")}),
    ]


def test_running_balance_matches_bql_open_close_windows(integration_client, bql_connection) -> None:
    ours = api_rows(
        integration_client,
        "SELECT year(date) AS y, month(date) AS m, last(balance) AS bal"
        f" FROM OPEN ON 2025-07-01 WHERE {ZKB_SUBTREE} GROUP BY y, m",
    )
    # September is a gap month for the subtree (ZKBX is outside): no row.
    assert [(year, month) for year, month, _ in ours] == [(2025, 7), (2025, 8), (2025, 10)]

    for year, month, balance in ours:
        next_start = f"{year + (month == 12):04d}-{month % 12 + 1:02d}-01"
        window = bql_rows(
            bql_connection,
            "SELECT sum(position) AS bal"
            f" FROM OPEN ON 2025-07-01 CLOSE ON {next_start} WHERE {ZKB_SUBTREE}",
        )
        assert window == [(balance,)], f"bucket {year}-{month:02d}"


def test_converted_total_matches_including_inverse_price(
    integration_client, bql_connection
) -> None:
    shared = f"SELECT convert(sum(position), 'CHF', 2025-10-31) AS val WHERE {ZKB_SUBTREE}"
    ours = api_rows(integration_client, shared)
    bql = bql_rows(bql_connection, shared)
    assert ours == bql
    # 4000 CHF + 50 USD x 0.80 + 10 EUR x (1 / 1.25) = 4048 CHF; the EUR rate
    # only exists as CHF->EUR, so both engines must use the inverse.
    assert ours == [({"CHF": Decimal("4048")},)]


def test_transitive_conversion_matches(integration_client, bql_connection) -> None:
    # VT is only priced in USD (like real stock commodities): converting to
    # CHF requires the VT->USD->CHF hop on both engines. beanquery only hops
    # via the position's *cost currency*, hence the {100.00 USD} cost basis
    # in the fixture; our engine hops via the price graph regardless.
    shared = (
        "SELECT convert(sum(position), 'CHF', 2025-10-31) AS val"
        " WHERE account ~ '^Assets:Invested:VT(:|$)'"
    )
    ours = api_rows(integration_client, shared)
    bql = bql_rows(bql_connection, shared)
    assert ours == bql
    # 5 VT x 100 USD x 0.80 = 400 CHF
    assert ours == [({"CHF": Decimal("400")},)]


def test_journal_matches(integration_client, bql_connection) -> None:
    shared = "SELECT date, account, number, currency WHERE account ~ '^Expenses:Groceries(:|$)'"
    ours = [
        (row[0], row[1], Decimal(row[2]), row[3]) for row in api_rows(integration_client, shared)
    ]
    bql = [
        (row[0].isoformat(), row[1], Decimal(row[2]), row[3])
        for row in bql_rows(bql_connection, shared + " ORDER BY date")
    ]
    assert ours == bql
    assert ours == [
        ("2025-07-20", "Expenses:Groceries", Decimal("200"), "CHF"),
        ("2025-08-03", "Expenses:Groceries", Decimal("300"), "CHF"),
    ]


def test_subtree_boundary_matches(integration_client, bql_connection) -> None:
    shared = f"SELECT count(*) AS n WHERE {ZKB_SUBTREE}"
    ours = api_rows(integration_client, shared)
    bql = bql_rows(bql_connection, shared)
    assert ours == bql
    # 7 postings touch the ZKB subtree; the ZKBX posting must not count.
    assert ours == [(7,)]
