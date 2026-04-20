from __future__ import annotations

import importlib
from decimal import Decimal

from fastapi.testclient import TestClient


def make_client() -> TestClient:
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    return TestClient(main_module.create_app())


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


def test_create_and_get_commodity() -> None:
    client = make_client()

    create_response = create_commodity(client, "CHF")

    assert create_response["name"].startswith("commodities/cmd_")

    get_response = client.get(f"/{create_response['name']}")

    assert get_response.status_code == 200
    assert get_response.json() == {
        "name": create_response["name"],
        "symbol": "CHF",
        "entity_metadata": {},
    }


def test_list_commodities_supports_pagination() -> None:
    client = make_client()

    for symbol in ["CHF", "GOOG", "USD"]:
        create_commodity(client, symbol)

    first_page = client.get("/commodities?page_size=2")

    assert first_page.status_code == 200
    body = first_page.json()
    assert len(body["commodities"]) == 2
    assert body["next_page_token"] is not None

    second_page = client.get(f"/commodities?page_size=2&page_token={body['next_page_token']}")

    assert second_page.status_code == 200
    assert len(second_page.json()["commodities"]) == 1
    assert second_page.json()["next_page_token"] is None


def test_create_and_get_transaction() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    uncategorized = create_account(client, "Expenses:Uncategorized")
    create_commodity(client, "CHF")

    create_response = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "payee": "Migros",
                "narration": "Groceries",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-100.00", "symbol": "CHF"},
                    },
                    {
                        "account": uncategorized["name"],
                        "units": {"amount": "100.00", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    assert create_response.status_code == 201
    body = create_response.json()
    assert body["name"].startswith("transactions/txn_")
    assert body["import_metadata"]["fingerprint"].startswith("sha256:")

    get_response = client.get(f"/{body['name']}")

    assert get_response.status_code == 200
    assert get_response.json()["postings"][0]["account"] == checking["name"]


def test_list_transactions_supports_filters_and_pagination() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created_names = []
    for tx_date, amount in [
        ("2026-04-01", "10.00"),
        ("2026-04-02", "20.00"),
        ("2026-04-03", "30.00"),
    ]:
        response = client.post(
            "/transactions",
            json={
                "transaction": {
                    "transaction_date": tx_date,
                    "postings": [
                        {
                            "account": checking["name"],
                            "units": {"amount": f"-{amount}", "symbol": "CHF"},
                        },
                        {
                            "account": food["name"],
                            "units": {"amount": amount, "symbol": "CHF"},
                        },
                    ],
                }
            },
        )
        created_names.append(response.json()["name"])

    first_page = client.get("/transactions?page_size=2")

    assert first_page.status_code == 200
    body = first_page.json()
    assert [tx["name"] for tx in body["transactions"]] == created_names[:2]
    assert body["next_page_token"] is not None

    filtered = client.get(f"/transactions?account={checking['name']}&from_date=2026-04-02")

    assert filtered.status_code == 200
    assert [tx["name"] for tx in filtered.json()["transactions"]] == created_names[1:]


def test_create_transaction_rejects_unknown_commodity() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")

    response = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "1.00", "symbol": "CHF"},
                    }
                ],
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "commodity_not_found"


def test_normalize_transaction_interpolates_one_missing_posting() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    response = client.post(
        "/transactions:normalize",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "payee": "Migros",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                    },
                ],
            }
        },
    )

    assert response.status_code == 200
    body = response.json()["transaction"]
    assert body["postings"][1]["units"] == {"amount": "84.25", "symbol": "CHF"}


def test_normalize_transaction_rejects_multiple_missing_postings() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    misc = create_account(client, "Expenses:Misc")

    response = client.post(
        "/transactions:normalize",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {"account": food["name"]},
                    {"account": misc["name"]},
                ],
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "multiple_missing_postings"


def test_create_transaction_normalizes_one_missing_posting() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    response = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {"account": food["name"]},
                ],
            }
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert Decimal(body["postings"][1]["units"]["amount"]) == Decimal("84.25")
    assert body["postings"][1]["units"]["symbol"] == "CHF"


def test_create_transaction_matches_normalize_output() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    payload = {
        "transaction": {
            "transaction_date": "2026-04-19",
            "payee": "Migros",
            "postings": [
                {
                    "account": checking["name"],
                    "units": {"amount": "-84.25", "symbol": "CHF"},
                },
                {
                    "account": food["name"],
                },
            ],
        }
    }

    normalized = client.post("/transactions:normalize", json=payload)
    created = client.post("/transactions", json=payload)

    assert normalized.status_code == 200
    assert created.status_code == 201
    for created_posting, normalized_posting in zip(
        created.json()["postings"], normalized.json()["transaction"]["postings"], strict=True
    ):
        assert created_posting["account"] == normalized_posting["account"]
        assert Decimal(created_posting["units"]["amount"]) == Decimal(
            normalized_posting["units"]["amount"]
        )
        assert created_posting["units"]["symbol"] == normalized_posting["units"]["symbol"]


def test_normalize_transaction_expands_multi_currency_missing_posting() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    cash = create_account(client, "Assets:Cash")
    equity = create_account(client, "Equity:Opening-Balances")
    create_commodity(client, "CHF")
    create_commodity(client, "EUR")

    response = client.post(
        "/transactions:normalize",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-95.65", "symbol": "CHF"},
                    },
                    {
                        "account": cash["name"],
                        "units": {"amount": "20.00", "symbol": "EUR"},
                    },
                    {"account": equity["name"]},
                ],
            }
        },
    )

    assert response.status_code == 200
    postings = response.json()["transaction"]["postings"]
    assert postings[2]["units"] == {"amount": "95.65", "symbol": "CHF"}
    assert postings[3]["units"] == {"amount": "-20.00", "symbol": "EUR"}


def test_create_transaction_expands_multi_currency_missing_posting() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    cash = create_account(client, "Assets:Cash")
    equity = create_account(client, "Equity:Opening-Balances")
    create_commodity(client, "CHF")
    create_commodity(client, "EUR")

    payload = {
        "transaction": {
            "transaction_date": "2026-04-19",
            "postings": [
                {
                    "account": checking["name"],
                    "units": {"amount": "-95.65", "symbol": "CHF"},
                },
                {
                    "account": cash["name"],
                    "units": {"amount": "20.00", "symbol": "EUR"},
                },
                {"account": equity["name"]},
            ],
        }
    }

    normalized = client.post("/transactions:normalize", json=payload)
    created = client.post("/transactions", json=payload)

    assert normalized.status_code == 200
    assert created.status_code == 201
    for created_posting, normalized_posting in zip(
        created.json()["postings"], normalized.json()["transaction"]["postings"], strict=True
    ):
        assert created_posting["account"] == normalized_posting["account"]
        assert Decimal(created_posting["units"]["amount"]) == Decimal(
            normalized_posting["units"]["amount"]
        )
        assert created_posting["units"]["symbol"] == normalized_posting["units"]["symbol"]


def test_create_and_get_price() -> None:
    client = make_client()

    create_commodity(client, "CHF")
    create_commodity(client, "USD")

    create_response = client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-19",
                "base_symbol": "USD",
                "quote": {"amount": "0.92", "symbol": "CHF"},
            }
        },
    )

    assert create_response.status_code == 201
    body = create_response.json()
    assert body["name"].startswith("prices/prc_")
    assert body["quote"]["symbol"] == "CHF"

    get_response = client.get(f"/prices/{body['name']}")

    assert get_response.status_code == 200
    assert get_response.json()["base_symbol"] == "USD"


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


def test_create_price_rejects_unknown_symbol() -> None:
    client = make_client()

    response = client.post(
        "/prices",
        json={
            "price": {
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
