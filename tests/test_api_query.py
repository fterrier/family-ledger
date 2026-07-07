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
