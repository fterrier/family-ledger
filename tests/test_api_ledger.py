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


def test_create_and_get_commodity() -> None:
    client = make_client()

    create_response = create_commodity(client, "CHF")

    assert create_response["name"].startswith("commodities/cmd_")

    get_response = client.get(f"/{create_response['name']}")

    assert get_response.status_code == 200
    assert get_response.json() == {
        "name": create_response["name"],
        "symbol": "CHF",
        "ticker": None,
        "entity_metadata": {},
    }


def test_delete_commodity_removes_it_and_returns_204() -> None:
    client = make_client()
    data = create_commodity(client, "CHF")
    name = data["name"]

    delete_resp = client.delete(f"/{name}")
    assert delete_resp.status_code == 204

    get_resp = client.get(f"/{name}")
    assert get_resp.status_code == 404


def test_delete_missing_commodity_returns_404() -> None:
    client = make_client()

    response = client.delete("/commodities/cmd_nonexistent")
    assert response.status_code == 404


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
                        "narration": "Produce",
                    },
                ],
            }
        },
    )

    assert create_response.status_code == 201
    body = create_response.json()
    assert body["name"].startswith("transactions/txn_")
    assert body["import_metadata"] is None

    get_response = client.get(f"/{body['name']}")

    assert get_response.status_code == 200
    assert get_response.json()["postings"][0]["account"] == checking["name"]
    assert get_response.json()["postings"][1]["narration"] == "Produce"


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


def test_normalize_transaction_returns_issues_for_unbalanced_payload() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

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
                    {
                        "account": food["name"],
                        "units": {"amount": "80.00", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    assert response.status_code == 200
    issues = response.json()["issues"]
    assert len(issues) == 1
    assert issues[0]["code"] == "transaction_unbalanced"
    assert issues[0]["details"] == {
        "symbol": "CHF",
        "residual_amount": "-4.25",
        "tolerance_amount": "0.01",
    }


def test_create_transaction_returns_canonical_resource_without_issues() -> None:
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
                    {
                        "account": food["name"],
                        "units": {"amount": "80.00", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    assert response.status_code == 201
    assert "issues" not in response.json()


def test_patch_transaction_recategorizes_posting() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    uncategorized = create_account(client, "Expenses:Uncategorized")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "payee": "Migros",
                "narration": "Groceries",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": uncategorized["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                    },
                ],
            }
        },
    )
    created_body = created.json()

    patched = client.patch(
        f"/{created_body['name']}",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "payee": "Migros",
                "narration": "Groceries",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                    },
                ],
            },
            "update_mask": "narration,postings",
        },
    )

    assert patched.status_code == 200
    body = patched.json()
    assert body["name"] == created_body["name"]
    assert body["postings"][1]["account"] == food["name"]


def test_patch_transaction_splits_posting() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    household = create_account(client, "Expenses:Household")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                        "narration": "Groceries",
                    },
                ],
            }
        },
    )

    patched = client.patch(
        f"/{created.json()['name']}",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "50.00", "symbol": "CHF"},
                        "narration": "Groceries",
                    },
                    {
                        "account": household["name"],
                        "units": {"amount": "34.25", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    assert patched.status_code == 200
    body = patched.json()
    assert [posting["account"] for posting in body["postings"]] == [
        checking["name"],
        food["name"],
        household["name"],
    ]
    assert [Decimal(posting["units"]["amount"]) for posting in body["postings"]] == [
        Decimal("-84.25"),
        Decimal("50.00"),
        Decimal("34.25"),
    ]
    assert [posting.get("narration") for posting in body["postings"]] == [None, "Groceries", None]


def test_patch_transaction_clears_posting_narration() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "narration": "Groceries",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                        "narration": "Produce",
                    },
                ],
            }
        },
    )

    patched = client.patch(
        f"/{created.json()['name']}",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "narration": "Groceries",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    assert patched.status_code == 200
    assert patched.json()["postings"][1]["narration"] is None


def test_patch_transaction_matches_normalize_output() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                    },
                ],
            }
        },
    )
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
    patched = client.patch(f"/{created.json()['name']}", json=payload)

    assert normalized.status_code == 200
    assert patched.status_code == 200
    for patched_posting, normalized_posting in zip(
        patched.json()["postings"], normalized.json()["transaction"]["postings"], strict=True
    ):
        assert patched_posting["account"] == normalized_posting["account"]
        assert Decimal(patched_posting["units"]["amount"]) == Decimal(
            normalized_posting["units"]["amount"]
        )
        assert patched_posting["units"]["symbol"] == normalized_posting["units"]["symbol"]


def test_patch_transaction_allows_total_change_without_lock() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    response = client.patch(
        f"/{created.json()['name']}",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-90.00", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "90.00", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    assert response.status_code == 200
    assert response.json()["postings"][0]["units"]["amount"] == "-90.00"


def test_patch_transaction_returns_canonical_resource_without_issues() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    response = client.patch(
        f"/{created.json()['name']}",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "80.00", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    assert response.status_code == 200
    assert "issues" not in response.json()


def test_get_and_list_transactions_do_not_inline_issues() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "80.00", "symbol": "CHF"},
                    },
                ],
            }
        },
    ).json()

    fetched = client.get(f"/{created['name']}")
    listed = client.get("/transactions")
    assert fetched.status_code == 200
    assert "issues" not in fetched.json()
    assert listed.status_code == 200
    assert "issues" not in listed.json()["transactions"][0]


def test_ledger_doctor_reports_unbalanced_transactions() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "80.00", "symbol": "CHF"},
                    },
                ],
            }
        },
    ).json()

    response = client.post("/ledger:doctor", json={})

    assert response.status_code == 200
    issues = response.json()["issues"]
    assert len(issues) == 1
    assert issues[0]["target"] == created["name"]
    assert issues[0]["code"] == "transaction_unbalanced"
    assert issues[0]["details"] == {
        "symbol": "CHF",
        "residual_amount": "-4.25",
        "tolerance_amount": "0.01",
    }
    assert issues[0]["target_summary"]["date"] == "2026-04-19"


def test_ledger_doctor_reports_fifo_lot_match_missing() -> None:
    client = make_client()

    broker = create_account(client, "Assets:Broker:Stocks")
    cash = create_account(client, "Assets:Broker:Cash")
    create_commodity(client, "AAPL")
    create_commodity(client, "USD")

    client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-01",
                "postings": [
                    {
                        "account": broker["name"],
                        "units": {"amount": "5", "symbol": "AAPL"},
                        "cost": {"amount": "100.00", "symbol": "USD"},
                    },
                    {
                        "account": cash["name"],
                        "units": {"amount": "-500.00", "symbol": "USD"},
                    },
                ],
            }
        },
    ).json()
    client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-02",
                "postings": [
                    {
                        "account": broker["name"],
                        "units": {"amount": "5", "symbol": "AAPL"},
                        "cost": {"amount": "100.00", "symbol": "USD"},
                    },
                    {
                        "account": cash["name"],
                        "units": {"amount": "-500.00", "symbol": "USD"},
                    },
                ],
            }
        },
    ).json()
    reducing = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-03",
                "postings": [
                    {
                        "account": broker["name"],
                        "units": {"amount": "-15", "symbol": "AAPL"},
                        "cost": {"amount": "100.00", "symbol": "USD"},
                    },
                    {
                        "account": cash["name"],
                        "units": {"amount": "1500.00", "symbol": "USD"},
                    },
                ],
            }
        },
    ).json()

    response = client.post("/ledger:doctor", json={})

    assert response.status_code == 200
    issues = response.json()["issues"]
    assert len(issues) == 1
    assert issues[0]["target"] == reducing["name"]
    assert issues[0]["code"] == "lot_match_missing"
    assert issues[0]["details"] == {
        "account": broker["account_name"],
        "units_symbol": "AAPL",
        "cost_symbol": "USD",
        "cost_per_unit": "100",
        "requested_amount": "15",
        "available_amount": "10",
    }
    assert issues[0]["target_summary"]["date"] == "2026-04-03"


def test_ledger_doctor_uses_bounded_queries() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    for day in range(1, 6):
        amount = Decimal("80.00") + Decimal(day)
        client.post(
            "/transactions",
            json={
                "transaction": {
                    "transaction_date": f"2026-04-0{day}",
                    "postings": [
                        {
                            "account": checking["name"],
                            "units": {"amount": "-84.25", "symbol": "CHF"},
                        },
                        {
                            "account": food["name"],
                            "units": {"amount": str(amount), "symbol": "CHF"},
                        },
                    ],
                }
            },
        )

    with count_sql_statements() as statements:
        response = client.post("/ledger:doctor", json={})

    assert response.status_code == 200
    assert len(response.json()["issues"]) == 5
    assert len(statements) <= 7


def test_ledger_doctor_reports_balance_assertion_failure() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    income = create_account(client, "Income:Salary")
    create_commodity(client, "CHF")
    _create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": income["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
    )
    assertion = _create_balance_assertion(client, checking["name"], "2026-01-02", "500.00", "CHF")

    response = client.post("/ledger:doctor", json={})

    assert response.status_code == 200
    issues = response.json()["issues"]
    ba_issues = [i for i in issues if i["code"] == "balance_assertion_failed"]
    assert len(ba_issues) == 1
    assert ba_issues[0]["target"] == assertion["name"]
    assert ba_issues[0]["severity"] == "error"


def test_ledger_doctor_no_balance_assertion_issue_when_satisfied() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    income = create_account(client, "Income:Salary")
    create_commodity(client, "CHF")
    _create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "500.00", "symbol": "CHF"}},
            {"account": income["name"], "units": {"amount": "-500.00", "symbol": "CHF"}},
        ],
    )
    _create_balance_assertion(client, checking["name"], "2026-01-02", "500.00", "CHF")

    response = client.post("/ledger:doctor", json={})

    assert response.status_code == 200
    ba_issues = [i for i in response.json()["issues"] if i["code"] == "balance_assertion_failed"]
    assert ba_issues == []


def test_patch_transaction_rejects_unknown_commodity() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "CHF"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "CHF"},
                    },
                ],
            }
        },
    )

    response = client.patch(
        f"/{created.json()['name']}",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [
                    {
                        "account": checking["name"],
                        "units": {"amount": "-84.25", "symbol": "USD"},
                    },
                    {
                        "account": food["name"],
                        "units": {"amount": "84.25", "symbol": "USD"},
                    },
                ],
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "commodity_not_found"


def test_patch_missing_transaction_returns_404() -> None:
    client = make_client()

    response = client.patch(
        "/transactions/txn_missing",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "postings": [],
            }
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "transaction_not_found"


def test_delete_transaction_removes_it_and_returns_204() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    create_commodity(client, "CHF")

    create_response = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-05-14",
                "payee": "To be deleted",
                "narration": "",
                "postings": [
                    {"account": checking["name"], "units": {"amount": "-1.00", "symbol": "CHF"}},
                ],
            }
        },
    )
    assert create_response.status_code == 201
    txn_name = create_response.json()["name"]

    delete_response = client.delete(f"/{txn_name}")
    assert delete_response.status_code == 204
    assert delete_response.content == b""

    get_response = client.get(f"/{txn_name}")
    assert get_response.status_code == 404


def test_delete_missing_transaction_returns_404() -> None:
    client = make_client()

    response = client.delete("/transactions/txn_missing")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "transaction_not_found"


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


def test_list_transactions_ordered_by_date_ascending() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    def post_tx(tx_date: str, amount: str) -> None:
        client.post(
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

    post_tx("2026-03-01", "30.00")
    post_tx("2026-01-01", "10.00")
    post_tx("2026-02-01", "20.00")

    response = client.get("/transactions")

    assert response.status_code == 200
    dates = [tx["transaction_date"] for tx in response.json()["transactions"]]
    assert dates == ["2026-01-01", "2026-02-01", "2026-03-01"]


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


# ---------------------------------------------------------------------------
# Pad endpoint — HTTP-level tests only; computation logic is in
# tests/test_services_account_balance.py
# ---------------------------------------------------------------------------


def _create_transaction(client: TestClient, tx_date: str, postings: list[dict]) -> dict:
    response = client.post(
        "/transactions",
        json={"transaction": {"transaction_date": tx_date, "postings": postings}},
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


def _pad(client: TestClient, account_name: str, pad_date: str) -> dict:
    response = client.get(f"/{account_name}:pad?date={pad_date}")
    assert response.status_code == 200
    return response.json()


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
