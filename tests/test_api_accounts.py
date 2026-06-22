from __future__ import annotations

import contextlib
import importlib
from collections.abc import Iterator
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import event


def make_client(api_token: str = "test-token") -> TestClient:
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    return TestClient(
        main_module.create_app(),
        headers={"Authorization": f"Bearer {api_token}"},
    )


def make_unauthenticated_client() -> TestClient:
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    return TestClient(main_module.create_app())


@contextlib.contextmanager
def count_sql_statements() -> Iterator[list[str]]:
    db_module = importlib.import_module("family_ledger.db")
    statements: list[str] = []

    def before_cursor_execute(
        _conn, _cursor, statement, _parameters, _context, _executemany
    ) -> None:
        statements.append(statement)

    event.listen(db_module.engine, "before_cursor_execute", before_cursor_execute)
    try:
        yield statements
    finally:
        event.remove(db_module.engine, "before_cursor_execute", before_cursor_execute)


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


def _create_transaction(
    client: TestClient,
    tx_date: str,
    postings: list[dict],
    *,
    source_native_ids: list[str] | None = None,
    payee: str | None = None,
    narration: str | None = None,
) -> dict:
    body: dict = {"transaction_date": tx_date, "postings": postings}
    if source_native_ids is not None:
        body["import_metadata"] = {"source_native_ids": source_native_ids}
    if payee is not None:
        body["payee"] = payee
    if narration is not None:
        body["narration"] = narration
    response = client.post("/transactions", json={"transaction": body})
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


def _pad(client: TestClient, account_name: str, pad_date: str) -> dict:
    response = client.get(f"/{account_name}:pad?date={pad_date}")
    assert response.status_code == 200
    return response.json()


def test_ledger_routes_require_authentication() -> None:
    client = make_unauthenticated_client()

    response = client.get("/accounts")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthenticated"


def test_ledger_routes_reject_invalid_token() -> None:
    client = make_client(api_token="wrong-token")

    response = client.get("/accounts")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthenticated"


def test_ledger_routes_reject_partial_token() -> None:
    client = make_client(api_token="test-toke")

    response = client.get("/accounts")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthenticated"


def test_create_and_list_accounts() -> None:
    client = make_client()

    create_response = create_account(client, "Assets:Bank:Checking:Family")

    assert create_response["name"].startswith("accounts/acc_")
    assert create_response["account_name"] == "Assets:Bank:Checking:Family"

    list_response = client.get("/accounts")

    assert list_response.status_code == 200
    assert list_response.json() == {
        "accounts": [
            {
                "name": create_response["name"],
                "account_name": "Assets:Bank:Checking:Family",
                "effective_start_date": "2020-01-01",
                "effective_end_date": None,
                "entity_metadata": {},
            }
        ],
        "next_page_token": None,
    }


def test_list_accounts_supports_pagination() -> None:
    client = make_client()

    for account_name in [
        "Assets:Bank:Checking:Family",
        "Assets:Broker:Cash:USD",
        "Expenses:Food",
    ]:
        create_account(client, account_name)

    first_page = client.get("/accounts?page_size=2")

    assert first_page.status_code == 200
    body = first_page.json()
    assert len(body["accounts"]) == 2
    assert body["next_page_token"] is not None

    second_page = client.get(f"/accounts?page_size=2&page_token={body['next_page_token']}")

    assert second_page.status_code == 200
    assert len(second_page.json()["accounts"]) == 1
    assert second_page.json()["next_page_token"] is None


def test_patch_account_updates_name_and_dates() -> None:
    client = make_client()
    created = create_account(client, "Assets:Bank:Checking:Family")
    account_name = created["name"]

    patch_resp = client.patch(
        f"/{account_name}",
        json={
            "account": {
                "account_name": "Assets:Bank:Checking:Family:Renamed",
                "effective_start_date": "2020-01-01",
                "effective_end_date": "2024-12-31",
            },
            "update_mask": "account_name,effective_start_date,effective_end_date",
        },
    )

    assert patch_resp.status_code == 200
    body = patch_resp.json()
    assert body["name"] == account_name
    assert body["account_name"] == "Assets:Bank:Checking:Family:Renamed"
    assert body["effective_start_date"] == "2020-01-01"
    assert body["effective_end_date"] == "2024-12-31"


def test_patch_account_not_found_returns_404() -> None:
    client = make_client()

    resp = client.patch(
        "/accounts/acc_nonexistent",
        json={
            "account": {
                "account_name": "Assets:Bank:Checking",
                "effective_start_date": "2020-01-01",
            },
            "update_mask": "account_name",
        },
    )

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "account_not_found"


def test_patch_account_rejects_end_before_start() -> None:
    client = make_client()
    created = create_account(client, "Assets:Bank:Checking:Family")

    resp = client.patch(
        f"/{created['name']}",
        json={
            "account": {
                "account_name": "Assets:Bank:Checking:Family",
                "effective_start_date": "2020-06-01",
                "effective_end_date": "2020-01-01",
            },
            "update_mask": "account_name,effective_start_date,effective_end_date",
        },
    )

    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "invalid_effective_date_range"


# ---------------------------------------------------------------------------
# Pad endpoint — HTTP-level tests only; computation logic is in
# tests/test_services_account_balance.py
# ---------------------------------------------------------------------------


def test_pad_returns_correct_json_shape() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    income = create_account(client, "Income:Salary")
    create_commodity(client, "USD")
    _create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "500.00", "symbol": "USD"}},
            {"account": income["name"], "units": {"amount": "-500.00", "symbol": "USD"}},
        ],
    )
    assertion = _create_balance_assertion(client, checking["name"], "2026-01-02", "1000.00", "USD")

    result = _pad(client, checking["name"], "2026-01-01")

    assert result["account"] == checking["name"]
    assert result["pad_date"] == "2026-01-01"
    assert len(result["entries"]) == 1
    entry = result["entries"][0]
    assert entry["balance_assertion"] == assertion["name"]
    assert entry["assertion_date"] == "2026-01-02"
    assert Decimal(entry["units"]["amount"]) == Decimal("500.00")
    assert entry["units"]["symbol"] == "USD"
    assert "cost" not in entry


def test_pad_rejects_unknown_account() -> None:
    client = make_client()

    response = client.get("/accounts/acc_missing:pad?date=2026-01-01")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "account_not_found"


def test_pad_cost_tracked_account_returns_400() -> None:
    client = make_client()
    portfolio = create_account(client, "Assets:Portfolio")
    cash = create_account(client, "Assets:Cash")
    create_commodity(client, "GOOG")
    create_commodity(client, "USD")
    _create_transaction(
        client,
        "2026-01-01",
        [
            {
                "account": portfolio["name"],
                "units": {"amount": "5", "symbol": "GOOG"},
                "cost": {"amount": "100.00", "symbol": "USD"},
            },
            {"account": cash["name"], "units": {"amount": "-500.00", "symbol": "USD"}},
        ],
    )
    _create_balance_assertion(client, portfolio["name"], "2026-01-02", "7", "GOOG")

    response = client.get(f"/{portfolio['name']}:pad?date=2026-01-01")

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "pad_cost_tracked_account"


def test_pad_transaction_with_multiple_postings_to_same_account_not_double_counted() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    _create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "300", "symbol": "CHF"}},
            {"account": checking["name"], "units": {"amount": "200", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-500", "symbol": "CHF"}},
        ],
    )
    _create_balance_assertion(client, checking["name"], "2026-01-02", "500", "CHF")

    response = client.get(f"/{checking['name']}:pad?date=2026-01-01")

    assert response.status_code == 200
    assert response.json()["entries"] == []
