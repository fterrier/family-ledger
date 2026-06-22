from __future__ import annotations

import importlib
from decimal import Decimal

from fastapi.testclient import TestClient


def make_client(api_token: str = "test-token") -> TestClient:
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    return TestClient(
        main_module.create_app(),
        headers={"Authorization": f"Bearer {api_token}"},
    )


def create_account(client: TestClient, account_name: str) -> dict:
    response = client.post(
        "/accounts",
        json={
            "account": {
                "account_name": account_name,
                "effective_start_date": "2020-01-01",
            }
        },
    )
    assert response.status_code == 201
    return response.json()


def create_commodity(client: TestClient, symbol: str) -> dict:
    response = client.post(
        "/commodities",
        json={"commodity": {"symbol": symbol}},
    )
    assert response.status_code == 201
    return response.json()


def _create_balance_assertion(
    client: TestClient,
    account_name: str,
    assertion_date: str,
    amount: str,
    symbol: str,
) -> dict:
    response = client.post(
        "/balance-assertions",
        json={
            "balance_assertion": {
                "assertion_date": assertion_date,
                "account": account_name,
                "amount": {"amount": amount, "symbol": symbol},
            }
        },
    )
    assert response.status_code == 201
    return response.json()


def test_create_balance_assertion() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    create_commodity(client, "CHF")

    create_response = client.post(
        "/balance-assertions",
        json={
            "balance_assertion": {
                "assertion_date": "2026-04-19",
                "account": checking["name"],
                "amount": {"amount": "1000.00", "symbol": "CHF"},
            }
        },
    )

    assert create_response.status_code == 201
    body = create_response.json()
    assert body["name"].startswith("balanceAssertions/bal_")
    assert body["account"] == checking["name"]

    get_response = client.get(f"/balance-assertions/{body['name']}")

    assert get_response.status_code == 200
    assert Decimal(get_response.json()["amount"]["amount"]) == Decimal("1000.00")


def test_list_balance_assertions_returns_all_assertions() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    savings = create_account(client, "Assets:Bank:Savings:Family")
    create_commodity(client, "CHF")

    _create_balance_assertion(client, checking["name"], "2026-04-30", "1000.00", "CHF")
    _create_balance_assertion(client, savings["name"], "2026-04-30", "2000.00", "CHF")

    response = client.get("/balance-assertions")

    assert response.status_code == 200
    body = response.json()
    assert len(body["balance_assertions"]) == 2
    assert body["next_page_token"] is None
    accounts = {ba["account"] for ba in body["balance_assertions"]}
    assert accounts == {checking["name"], savings["name"]}


def test_list_balance_assertions_empty() -> None:
    client = make_client()

    response = client.get("/balance-assertions")

    assert response.status_code == 200
    assert response.json() == {"balance_assertions": [], "next_page_token": None}


def test_list_balance_assertions_ordered_by_date_ascending() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    create_commodity(client, "CHF")

    _create_balance_assertion(client, checking["name"], "2026-03-31", "900.00", "CHF")
    _create_balance_assertion(client, checking["name"], "2026-01-31", "800.00", "CHF")
    _create_balance_assertion(client, checking["name"], "2026-02-28", "850.00", "CHF")

    response = client.get("/balance-assertions")

    assert response.status_code == 200
    dates = [ba["assertion_date"] for ba in response.json()["balance_assertions"]]
    assert dates == ["2026-01-31", "2026-02-28", "2026-03-31"]


def test_create_balance_assertion_rejects_unknown_account() -> None:
    client = make_client()

    create_commodity(client, "CHF")

    response = client.post(
        "/balance-assertions",
        json={
            "balance_assertion": {
                "assertion_date": "2026-04-19",
                "account": "accounts/acc_missing",
                "amount": {"amount": "1000.00", "symbol": "CHF"},
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "account_not_found"


def test_update_balance_assertion() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    savings = create_account(client, "Assets:Bank:Savings:Family")
    create_commodity(client, "CHF")

    created = _create_balance_assertion(client, checking["name"], "2026-04-19", "1000.00", "CHF")

    response = client.patch(
        f"/balance-assertions/{created['name']}",
        json={
            "balance_assertion": {
                "assertion_date": "2026-04-20",
                "account": savings["name"],
                "amount": {"amount": "1500.00", "symbol": "CHF"},
            }
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == created["name"]
    assert body["assertion_date"] == "2026-04-20"
    assert body["account"] == savings["name"]
    assert Decimal(body["amount"]["amount"]) == Decimal("1500.00")


def test_update_balance_assertion_not_found() -> None:
    client = make_client()

    response = client.patch(
        "/balance-assertions/balanceAssertions/bal_missing",
        json={
            "balance_assertion": {
                "assertion_date": "2026-04-19",
                "account": "accounts/acc_missing",
                "amount": {"amount": "100.00", "symbol": "CHF"},
            }
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "balance_assertion_not_found"


def test_delete_balance_assertion() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    create_commodity(client, "CHF")

    created = _create_balance_assertion(client, checking["name"], "2026-04-19", "1000.00", "CHF")

    delete_response = client.delete(f"/balance-assertions/{created['name']}")
    assert delete_response.status_code == 204

    get_response = client.get(f"/balance-assertions/{created['name']}")
    assert get_response.status_code == 404


def test_delete_balance_assertion_not_found() -> None:
    client = make_client()

    response = client.delete("/balance-assertions/balanceAssertions/bal_missing")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "balance_assertion_not_found"
