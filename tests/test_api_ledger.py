from __future__ import annotations

import importlib
from decimal import Decimal

from fastapi.testclient import TestClient


def make_client() -> TestClient:
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    return TestClient(main_module.create_app())


def test_create_and_list_accounts() -> None:
    client = make_client()

    create_response = client.post(
        "/accounts",
        json={
            "account": {
                "name": "accounts/checking-family",
                "ledger_name": "Assets:Bank:Checking:Family",
                "effective_start_date": "2020-01-01",
            }
        },
    )

    assert create_response.status_code == 201
    assert create_response.json()["name"] == "accounts/checking-family"

    list_response = client.get("/accounts")

    assert list_response.status_code == 200
    assert list_response.json() == {
        "accounts": [
            {
                "name": "accounts/checking-family",
                "ledger_name": "Assets:Bank:Checking:Family",
                "effective_start_date": "2020-01-01",
                "effective_end_date": None,
                "entity_metadata": {},
            }
        ]
    }


def test_create_and_get_commodity() -> None:
    client = make_client()

    create_response = client.post(
        "/commodities",
        json={
            "commodity": {
                "name": "commodities/chf",
                "symbol": "CHF",
            }
        },
    )

    assert create_response.status_code == 201

    get_response = client.get("/commodities/chf")

    assert get_response.status_code == 200
    assert get_response.json() == {
        "name": "commodities/chf",
        "symbol": "CHF",
        "entity_metadata": {},
    }


def test_create_and_get_transaction() -> None:
    client = make_client()

    client.post(
        "/accounts",
        json={
            "account": {
                "name": "accounts/checking-family",
                "ledger_name": "Assets:Bank:Checking:Family",
                "effective_start_date": "2020-01-01",
            }
        },
    )
    client.post(
        "/accounts",
        json={
            "account": {
                "name": "accounts/expenses-uncategorized",
                "ledger_name": "Expenses:Uncategorized",
                "effective_start_date": "2020-01-01",
            }
        },
    )
    client.post(
        "/commodities",
        json={
            "commodity": {
                "name": "commodities/chf",
                "symbol": "CHF",
            }
        },
    )

    create_response = client.post(
        "/transactions",
        json={
            "transaction": {
                "name": "transactions/txn-1",
                "transaction_date": "2026-04-19",
                "payee": "Migros",
                "narration": "Groceries",
                "postings": [
                    {
                        "account": "accounts/checking-family",
                        "units": {"amount": "-100.00", "symbol": "CHF"},
                    },
                    {
                        "account": "accounts/expenses-uncategorized",
                        "units": {"amount": "100.00", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    assert create_response.status_code == 201
    body = create_response.json()
    assert body["name"] == "transactions/txn-1"
    assert body["import_metadata"]["fingerprint"].startswith("sha256:")

    get_response = client.get("/transactions/txn-1")

    assert get_response.status_code == 200
    assert get_response.json()["postings"][0]["account"] == "accounts/checking-family"


def test_create_transaction_rejects_unknown_commodity() -> None:
    client = make_client()

    client.post(
        "/accounts",
        json={
            "account": {
                "name": "accounts/checking-family",
                "ledger_name": "Assets:Bank:Checking:Family",
                "effective_start_date": "2020-01-01",
            }
        },
    )

    response = client.post(
        "/transactions",
        json={
            "transaction": {
                "name": "transactions/txn-1",
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": "accounts/checking-family",
                        "units": {"amount": "1.00", "symbol": "CHF"},
                    }
                ],
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "commodity_not_found"


def test_create_and_get_price() -> None:
    client = make_client()

    client.post(
        "/commodities",
        json={"commodity": {"name": "commodities/chf", "symbol": "CHF"}},
    )
    client.post(
        "/commodities",
        json={"commodity": {"name": "commodities/usd", "symbol": "USD"}},
    )

    create_response = client.post(
        "/prices",
        json={
            "price": {
                "name": "prices/usd-chf-2026-04-19",
                "price_date": "2026-04-19",
                "base_symbol": "USD",
                "quote": {"amount": "0.92", "symbol": "CHF"},
            }
        },
    )

    assert create_response.status_code == 201
    assert create_response.json()["quote"]["symbol"] == "CHF"

    get_response = client.get("/prices/usd-chf-2026-04-19")

    assert get_response.status_code == 200
    assert get_response.json()["base_symbol"] == "USD"


def test_create_balance_assertion() -> None:
    client = make_client()

    client.post(
        "/accounts",
        json={
            "account": {
                "name": "accounts/checking-family",
                "ledger_name": "Assets:Bank:Checking:Family",
                "effective_start_date": "2020-01-01",
            }
        },
    )
    client.post(
        "/commodities",
        json={"commodity": {"name": "commodities/chf", "symbol": "CHF"}},
    )

    create_response = client.post(
        "/balance-assertions",
        json={
            "balance_assertion": {
                "name": "balanceAssertions/checking-family-2026-04-19",
                "assertion_date": "2026-04-19",
                "account": "accounts/checking-family",
                "amount": {"amount": "1000.00", "symbol": "CHF"},
            }
        },
    )

    assert create_response.status_code == 201
    assert create_response.json()["account"] == "accounts/checking-family"

    get_response = client.get("/balance-assertions/checking-family-2026-04-19")

    assert get_response.status_code == 200
    assert Decimal(get_response.json()["amount"]["amount"]) == Decimal("1000.00")


def test_create_price_rejects_unknown_symbol() -> None:
    client = make_client()

    response = client.post(
        "/prices",
        json={
            "price": {
                "name": "prices/usd-chf-2026-04-19",
                "price_date": "2026-04-19",
                "base_symbol": "USD",
                "quote": {"amount": "0.92", "symbol": "CHF"},
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "commodity_not_found"


def test_create_balance_assertion_rejects_unknown_account() -> None:
    client = make_client()

    client.post(
        "/commodities",
        json={"commodity": {"name": "commodities/chf", "symbol": "CHF"}},
    )

    response = client.post(
        "/balance-assertions",
        json={
            "balance_assertion": {
                "name": "balanceAssertions/checking-family-2026-04-19",
                "assertion_date": "2026-04-19",
                "account": "accounts/checking-family",
                "amount": {"amount": "1000.00", "symbol": "CHF"},
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "account_not_found"
