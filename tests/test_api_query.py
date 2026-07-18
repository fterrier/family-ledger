from __future__ import annotations

from api_helpers import (
    create_account,
    create_commodity,
    create_transaction,
    make_client,
    make_unauthenticated_client,
)
from fastapi.testclient import TestClient


def _seed_ledger(client: TestClient) -> None:
    create_commodity(client, "CHF")
    create_commodity(client, "USD")
    checking = create_account(client, "Assets:Checking:ZKB")
    sub = create_account(client, "Assets:Checking:ZKB:Sub")
    groceries = create_account(client, "Expenses:Groceries")
    opening = create_account(client, "Equity:Opening")
    create_transaction(
        client,
        "2025-05-10",
        [
            {"account": checking["name"], "units": {"amount": "1000", "symbol": "CHF"}},
            {"account": opening["name"], "units": {"amount": "-1000", "symbol": "CHF"}},
        ],
    )
    create_transaction(
        client,
        "2025-07-20",
        [
            {"account": groceries["name"], "units": {"amount": "200", "symbol": "CHF"}},
            {"account": checking["name"], "units": {"amount": "-200", "symbol": "CHF"}},
        ],
    )
    create_transaction(
        client,
        "2025-08-15",
        [
            {"account": sub["name"], "units": {"amount": "50", "symbol": "USD"}},
            {"account": opening["name"], "units": {"amount": "-50", "symbol": "USD"}},
        ],
    )


def test_query_requires_auth() -> None:
    client = make_unauthenticated_client()
    response = client.post("/ledger:query", json={"query": "SELECT count(*)"})
    assert response.status_code in (401, 403)


def test_query_balance_series() -> None:
    client = make_client()
    _seed_ledger(client)

    response = client.post(
        "/ledger:query",
        json={
            "query": (
                "SELECT year(date) AS y, month(date) AS m, last(balance) AS bal"
                " FROM OPEN ON 2025-07-01"
                " WHERE account ~ '^Assets:Checking:ZKB(:|$)'"
                " GROUP BY y, m"
            )
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "columns": [
            {"name": "y", "type": "int"},
            {"name": "m", "type": "int"},
            {"name": "bal", "type": "inventory"},
        ],
        "rows": [
            [2025, 7, [{"number": "800", "currency": "CHF"}]],
            [
                2025,
                8,
                [
                    {"number": "800", "currency": "CHF"},
                    {"number": "50", "currency": "USD"},
                ],
            ],
        ],
        "warnings": [],
    }


def test_query_multi_root_alternation_nets_subtrees() -> None:
    client = make_client()
    _seed_ledger(client)

    response = client.post(
        "/ledger:query",
        json={
            "query": (
                "SELECT year(date) AS y, month(date) AS m, sum(position) AS total"
                " WHERE account ~ '^(Assets|Expenses)(:|$)'"
                " GROUP BY y, m"
            )
        },
    )
    assert response.status_code == 200
    body = response.json()
    # May: Assets +1000; Jul: Expenses +200 net Assets −200 = 0 folds to
    # empty; Aug: Assets:...:Sub +50 USD.
    assert body["rows"] == [
        [2025, 5, [{"number": "1000", "currency": "CHF"}]],
        [2025, 7, []],
        [2025, 8, [{"number": "50", "currency": "USD"}]],
    ]
    assert body["warnings"] == []


def test_query_conversion_uses_stored_prices_and_warns_on_gaps() -> None:
    client = make_client()
    _seed_ledger(client)

    query = {
        "query": (
            "SELECT year(date) AS y, month(date) AS m, convert(last(balance), 'CHF') AS bal"
            " WHERE account ~ '^Assets:Checking:ZKB(:|$)'"
            " GROUP BY y, m"
        )
    }

    # Without a USD price the August cell is null and a warning is emitted.
    response = client.post("/ledger:query", json=query)
    assert response.status_code == 200
    body = response.json()
    assert body["rows"][-1][2] is None
    assert body["warnings"] == [
        {
            "code": "missing_price",
            "message": "No CHF price for USD on or before 2025-08-31.",
            "details": {"base": "USD", "quote": "CHF", "date": "2025-08-31"},
        }
    ]

    price_response = client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2025-08-10",
                "base_symbol": "USD",
                "quote": {"amount": "0.80", "symbol": "CHF"},
            }
        },
    )
    assert price_response.status_code == 201

    response = client.post("/ledger:query", json=query)
    assert response.status_code == 200
    body = response.json()
    assert body["rows"][-1][2] == {"number": "840", "currency": "CHF"}
    assert body["warnings"] == []


def test_query_convert_of_a_posting_already_in_target_currency_still_converts_via_weight() -> None:
    # A posting whose own units already ARE the target currency is NOT a
    # shortcut: 100 CHF bought at cost {1.5 USD} really cost 150 USD, and
    # that's what should get re-priced — a trivial 100 CHF would silently
    # ignore the fact that this was actually a currency purchase. Matches
    # bean-query's convert_position, which always reduces to weight first.
    client = make_client()
    for symbol in ("CHF", "USD"):
        create_commodity(client, symbol)
    weird = create_account(client, "Assets:Weird")
    opening = create_account(client, "Equity:Opening")

    client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-01",
                "base_symbol": "USD",
                "quote": {"amount": "2.00", "symbol": "CHF"},
            }
        },
    )
    create_transaction(
        client,
        "2026-04-10",
        [
            {
                "account": weird["name"],
                "units": {"amount": "200", "symbol": "CHF"},
                "cost": {"amount": "1.5", "symbol": "USD"},
            },
            {"account": opening["name"], "units": {"amount": "-300", "symbol": "USD"}},
        ],
    )

    response = client.post(
        "/ledger:query",
        json={
            "query": (
                "SELECT account, convert(sum(position), 'CHF', 2026-04-10) AS total"
                " WHERE account = 'Assets:Weird' GROUP BY account"
            )
        },
    )

    assert response.status_code == 200
    body = response.json()
    # 200 * 1.5 USD weight = 300 USD, re-priced USD->CHF at 2.0 = 600 CHF —
    # not a trivial 200 CHF pass-through.
    assert body["rows"] == [["Assets:Weird", {"number": "600", "currency": "CHF"}]]
    assert body["warnings"] == []


def test_query_convert_of_sum_number_on_a_cost_bearing_posting_in_the_target_currency() -> None:
    # sum(number) shares its SQL shape with sum(position) (both group by
    # currency); this pins that convert(sum(number), ...) applies the same
    # always-weight rule, not just convert(sum(position), ...).
    client = make_client()
    for symbol in ("CHF", "USD"):
        create_commodity(client, symbol)
    weird = create_account(client, "Assets:Weird")
    opening = create_account(client, "Equity:Opening")

    client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-01",
                "base_symbol": "USD",
                "quote": {"amount": "2.00", "symbol": "CHF"},
            }
        },
    )
    create_transaction(
        client,
        "2026-04-10",
        [
            {
                "account": weird["name"],
                "units": {"amount": "200", "symbol": "CHF"},
                "cost": {"amount": "1.5", "symbol": "USD"},
            },
            {"account": opening["name"], "units": {"amount": "-300", "symbol": "USD"}},
        ],
    )

    response = client.post(
        "/ledger:query",
        json={
            "query": (
                "SELECT account, convert(sum(number), 'CHF', 2026-04-10) AS total"
                " WHERE account = 'Assets:Weird' GROUP BY account"
            )
        },
    )

    assert response.status_code == 200
    assert response.json()["rows"] == [["Assets:Weird", {"number": "600", "currency": "CHF"}]]


def test_query_convert_values_a_cost_bearing_position_via_its_weight() -> None:
    # A security posting (e.g. holding shares) converts via its cost
    # currency (the weight), not by pricing the security symbol itself —
    # even if the ledger happens to have a (here, deliberately wrong) price
    # series for the security directly. Mirrors
    # test_convert_values_a_cost_bearing_posting_via_its_weight_not_its_own_price
    # in test_api_transactions.py — same rule, query endpoint this time.
    client = make_client()
    for symbol in ("CHF", "USD", "VSS"):
        create_commodity(client, symbol)
    broker_usd = create_account(client, "Assets:Broker:USD")
    broker_vss = create_account(client, "Assets:Broker:VSS")

    client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-01",
                "base_symbol": "USD",
                "quote": {"amount": "0.90", "symbol": "CHF"},
            }
        },
    )
    # Decoy: if this were used directly instead of the weight, 10 x 100 x
    # 0.90 = 900 CHF, not the correct 950 x 0.90 = 855 CHF via cost.
    client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-01",
                "base_symbol": "VSS",
                "quote": {"amount": "100", "symbol": "USD"},
            }
        },
    )
    create_transaction(
        client,
        "2026-04-10",
        [
            {"account": broker_usd["name"], "units": {"amount": "-950.00", "symbol": "USD"}},
            {
                "account": broker_vss["name"],
                "units": {"amount": "10", "symbol": "VSS"},
                "cost": {"amount": "95.00", "symbol": "USD"},
            },
        ],
    )

    response = client.post(
        "/ledger:query",
        json={
            "query": (
                "SELECT account, convert(sum(position), 'CHF', 2026-04-10) AS total"
                " WHERE account = 'Assets:Broker:VSS'"
                " GROUP BY account"
            )
        },
    )

    assert response.status_code == 200
    assert response.json()["rows"] == [["Assets:Broker:VSS", {"number": "855", "currency": "CHF"}]]


def test_query_convert_of_a_cost_bearing_position_already_in_the_target_currency() -> None:
    # The weight is already the target currency (bought at cost in CHF) —
    # this must not require a price row for the security symbol.
    client = make_client()
    for symbol in ("CHF", "VSS"):
        create_commodity(client, symbol)
    broker_chf = create_account(client, "Assets:Broker:CHF")
    broker_vss = create_account(client, "Assets:Broker:VSS")

    create_transaction(
        client,
        "2026-04-10",
        [
            {"account": broker_chf["name"], "units": {"amount": "-950.00", "symbol": "CHF"}},
            {
                "account": broker_vss["name"],
                "units": {"amount": "10", "symbol": "VSS"},
                "cost": {"amount": "95.00", "symbol": "CHF"},
            },
        ],
    )

    response = client.post(
        "/ledger:query",
        json={
            "query": (
                "SELECT account, convert(sum(position), 'CHF', 2026-04-10) AS total"
                " WHERE account = 'Assets:Broker:VSS'"
                " GROUP BY account"
            )
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["rows"] == [["Assets:Broker:VSS", {"number": "950", "currency": "CHF"}]]
    assert body["warnings"] == []


def test_query_journal() -> None:
    client = make_client()
    _seed_ledger(client)

    response = client.post(
        "/ledger:query",
        json={
            "query": (
                "SELECT date, account, number, currency WHERE account ~ '^Expenses:Groceries(:|$)'"
            )
        },
    )
    assert response.status_code == 200
    assert response.json()["rows"] == [["2025-07-20", "Expenses:Groceries", "200", "CHF"]]


def test_query_parse_error_envelope() -> None:
    client = make_client()
    response = client.post("/ledger:query", json={"query": "SELECT account extra"})
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "query_parse_error"
    assert "extra" in detail["message"]


def test_query_validation_error_envelope() -> None:
    client = make_client()
    response = client.post("/ledger:query", json={"query": "SELECT frobnicate"})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "query_validation_error"
