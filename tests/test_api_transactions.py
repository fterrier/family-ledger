from __future__ import annotations

from decimal import Decimal

from api_helpers import (
    count_sql_statements,
    create_account,
    create_balance_assertion,
    create_commodity,
    create_transaction,
    make_client,
)


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
    assert get_response.json()["postings"][0]["account_name"] == "Assets:Bank:Checking:Family"
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


def _create_price(client, price_date: str, base: str, amount: str, quote: str) -> None:
    response = client.post(
        "/prices",
        json={
            "price": {
                "price_date": price_date,
                "base_symbol": base,
                "quote": {"amount": amount, "symbol": quote},
            }
        },
    )
    assert response.status_code == 201


def test_list_transactions_convert_values_postings_at_transaction_date() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking")
    opening = create_account(client, "Equity:Opening")
    for symbol in ("CHF", "USD", "GBP", "JPY"):
        create_commodity(client, symbol)

    # USD has a direct CHF price before the transaction date and a fresher
    # one after it (which must NOT be used); GBP is only priced in USD
    # (transitive hop); JPY has no price path at all.
    _create_price(client, "2026-04-01", "USD", "0.85", "CHF")
    _create_price(client, "2026-04-20", "USD", "0.80", "CHF")
    _create_price(client, "2026-04-01", "GBP", "1.25", "USD")

    create_transaction(
        client,
        "2026-04-10",
        [
            {"account": checking["name"], "units": {"amount": "-100", "symbol": "CHF"}},
            {"account": opening["name"], "units": {"amount": "100", "symbol": "CHF"}},
            {"account": checking["name"], "units": {"amount": "40", "symbol": "USD"}},
            {"account": opening["name"], "units": {"amount": "-40", "symbol": "USD"}},
            {"account": checking["name"], "units": {"amount": "20", "symbol": "GBP"}},
            {"account": opening["name"], "units": {"amount": "-20", "symbol": "GBP"}},
            {"account": checking["name"], "units": {"amount": "500", "symbol": "JPY"}},
            {"account": opening["name"], "units": {"amount": "-500", "symbol": "JPY"}},
        ],
    )

    response = client.get("/transactions?convert=CHF")

    assert response.status_code == 200
    postings = response.json()["transactions"][0]["postings"]
    by_symbol = {p["units"]["symbol"]: p for p in postings if p["account"] == checking["name"]}
    # Same currency: nothing to convert.
    assert by_symbol["CHF"]["converted_units"] is None
    # Direct pair at the transaction date's rate (0.85), not the fresher
    # post-date 0.80.
    assert by_symbol["USD"]["converted_units"] == {"amount": "34", "symbol": "CHF"}
    # Transitive hop GBP -> USD -> CHF: 20 x 1.25 x 0.85 (normalized like
    # the query endpoint: no trailing zeros).
    assert by_symbol["GBP"]["converted_units"] == {"amount": "21.25", "symbol": "CHF"}
    # No price path: null, client falls back to the raw amount.
    assert by_symbol["JPY"]["converted_units"] is None


def test_list_transactions_without_convert_has_no_converted_units() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking")
    opening = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")
    create_transaction(
        client,
        "2026-04-10",
        [
            {"account": checking["name"], "units": {"amount": "-10", "symbol": "CHF"}},
            {"account": opening["name"], "units": {"amount": "10", "symbol": "CHF"}},
        ],
    )

    response = client.get("/transactions")

    assert response.status_code == 200
    for posting in response.json()["transactions"][0]["postings"]:
        assert posting["converted_units"] is None


def test_get_transaction_convert_values_postings_at_transaction_date() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking")
    opening = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")
    create_commodity(client, "USD")
    _create_price(client, "2026-04-01", "USD", "0.85", "CHF")

    created = create_transaction(
        client,
        "2026-04-10",
        [
            {"account": checking["name"], "units": {"amount": "40", "symbol": "USD"}},
            {"account": opening["name"], "units": {"amount": "-40", "symbol": "USD"}},
        ],
    )

    without_convert = client.get(f"/{created['name']}")
    assert without_convert.status_code == 200
    assert without_convert.json()["postings"][0]["converted_units"] is None

    with_convert = client.get(f"/{created['name']}?convert=CHF")
    assert with_convert.status_code == 200
    assert with_convert.json()["postings"][0]["converted_units"] == {
        "amount": "34",
        "symbol": "CHF",
    }


def test_get_transaction_after_edit_still_converts() -> None:
    # Regression: get_transaction_by_name must build its own price lookup —
    # a transaction fetched right after a PATCH must convert exactly like a
    # transaction fetched from the list.
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking")
    opening = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")
    create_commodity(client, "USD")
    _create_price(client, "2026-04-01", "USD", "0.85", "CHF")

    created = create_transaction(
        client,
        "2026-04-10",
        [
            {"account": checking["name"], "units": {"amount": "40", "symbol": "USD"}},
            {"account": opening["name"], "units": {"amount": "-40", "symbol": "USD"}},
        ],
    )

    patch_response = client.patch(
        f"/{created['name']}",
        json={
            "transaction": {
                "transaction_date": "2026-04-10",
                "postings": [
                    {"account": checking["name"], "units": {"amount": "50", "symbol": "USD"}},
                    {"account": opening["name"], "units": {"amount": "-50", "symbol": "USD"}},
                ],
            }
        },
    )
    assert patch_response.status_code == 200

    response = client.get(f"/{created['name']}?convert=CHF")
    assert response.status_code == 200
    assert response.json()["postings"][0]["converted_units"] == {
        "amount": "42.5",
        "symbol": "CHF",
    }


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


def test_create_transaction_with_tags() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    response = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "tags": ["salary2023", "bonus"],
                "postings": [
                    {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
                    {"account": food["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
                ],
            }
        },
    )

    assert response.status_code == 201
    assert response.json()["tags"] == ["salary2023", "bonus"]


def test_create_transaction_rejects_tag_with_whitespace() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    response = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "tags": ["bad tag"],
                "postings": [
                    {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
                    {"account": food["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
                ],
            }
        },
    )

    assert response.status_code == 422


def test_create_transaction_rejects_empty_tag() -> None:
    client = make_client()

    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    response = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-04-19",
                "tags": [""],
                "postings": [
                    {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
                    {"account": food["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
                ],
            }
        },
    )

    assert response.status_code == 422


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
    create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": income["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
    )
    assertion = create_balance_assertion(client, checking["name"], "2026-01-02", "500.00", "CHF")

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
    create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "500.00", "symbol": "CHF"}},
            {"account": income["name"], "units": {"amount": "-500.00", "symbol": "CHF"}},
        ],
    )
    create_balance_assertion(client, checking["name"], "2026-01-02", "500.00", "CHF")

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


def test_list_transactions_ordered_by_date_descending() -> None:
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

    response = client.get("/transactions?order=desc")

    assert response.status_code == 200
    dates = [tx["transaction_date"] for tx in response.json()["transactions"]]
    assert dates == ["2026-03-01", "2026-02-01", "2026-01-01"]


def test_list_transactions_account_filter_no_duplicates_when_multiple_postings() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    tx = create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "300", "symbol": "CHF"}},
            {"account": checking["name"], "units": {"amount": "200", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-500", "symbol": "CHF"}},
        ],
    )

    response = client.get(f"/transactions?account={checking['name']}")

    assert response.status_code == 200
    names = [t["name"] for t in response.json()["transactions"]]
    assert names == [tx["name"]]


def test_list_transactions_account_name_exact_match() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking")
    savings = create_account(client, "Assets:Bank:Savings")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    tx_checking = create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "-100", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "100", "symbol": "CHF"}},
        ],
    )
    create_transaction(
        client,
        "2026-01-02",
        [
            {"account": savings["name"], "units": {"amount": "-200", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "200", "symbol": "CHF"}},
        ],
    )

    response = client.get("/transactions?account_name=Assets:Bank:Checking")

    assert response.status_code == 200
    names = [t["name"] for t in response.json()["transactions"]]
    assert names == [tx_checking["name"]]


def test_list_transactions_account_name_prefix_match() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking")
    savings = create_account(client, "Assets:Bank:Savings")
    expenses = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    tx1 = create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "-100", "symbol": "CHF"}},
            {"account": expenses["name"], "units": {"amount": "100", "symbol": "CHF"}},
        ],
    )
    tx2 = create_transaction(
        client,
        "2026-01-02",
        [
            {"account": savings["name"], "units": {"amount": "-200", "symbol": "CHF"}},
            {"account": expenses["name"], "units": {"amount": "200", "symbol": "CHF"}},
        ],
    )
    create_transaction(
        client,
        "2026-01-03",
        [
            {"account": expenses["name"], "units": {"amount": "50", "symbol": "CHF"}},
            {"account": expenses["name"], "units": {"amount": "50", "symbol": "CHF"}},
        ],
    )

    response = client.get("/transactions?account_name=Assets:Bank&order=asc")

    assert response.status_code == 200
    names = [t["name"] for t in response.json()["transactions"]]
    assert names == [tx1["name"], tx2["name"]]


def test_list_transactions_account_name_no_duplicates() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking")
    savings = create_account(client, "Assets:Bank:Savings")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    tx = create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "300", "symbol": "CHF"}},
            {"account": savings["name"], "units": {"amount": "200", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-500", "symbol": "CHF"}},
        ],
    )

    response = client.get("/transactions?account_name=Assets:Bank")

    assert response.status_code == 200
    names = [t["name"] for t in response.json()["transactions"]]
    assert names == [tx["name"]]


def test_list_transactions_currency_filter() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking")
    brokerage = create_account(client, "Assets:Broker:IBKR")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")
    create_commodity(client, "USD")

    tx_chf = create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "-100", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "100", "symbol": "CHF"}},
        ],
    )
    create_transaction(
        client,
        "2026-01-02",
        [
            {"account": brokerage["name"], "units": {"amount": "-50", "symbol": "USD"}},
            {"account": equity["name"], "units": {"amount": "50", "symbol": "USD"}},
        ],
    )

    response = client.get("/transactions?currency=CHF")

    assert response.status_code == 200
    names = [t["name"] for t in response.json()["transactions"]]
    assert names == [tx_chf["name"]]


def test_list_transactions_currency_filter_combines_with_account_name() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking")
    brokerage = create_account(client, "Assets:Broker:IBKR")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")
    create_commodity(client, "USD")

    create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "-100", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "100", "symbol": "CHF"}},
        ],
    )
    tx_broker_usd = create_transaction(
        client,
        "2026-01-02",
        [
            {"account": brokerage["name"], "units": {"amount": "-50", "symbol": "USD"}},
            {"account": equity["name"], "units": {"amount": "50", "symbol": "USD"}},
        ],
    )
    create_transaction(
        client,
        "2026-01-03",
        [
            {"account": brokerage["name"], "units": {"amount": "-10", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "10", "symbol": "CHF"}},
        ],
    )

    # AND semantics: only the brokerage transaction that is also in USD.
    response = client.get("/transactions?account_name=Assets:Broker&currency=USD")

    assert response.status_code == 200
    names = [t["name"] for t in response.json()["transactions"]]
    assert names == [tx_broker_usd["name"]]


def test_list_transactions_account_name_and_currency_require_same_posting() -> None:
    client = make_client()
    brokerage = create_account(client, "Assets:Broker:IBKR")
    other = create_account(client, "Assets:Cash")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")
    create_commodity(client, "USD")

    # The brokerage leg is CHF only; the USD amount lives on a *different*
    # posting (Assets:Cash), balanced by an elastic-equity plug that expands
    # into one CHF leg and one USD leg. account_name=Broker matches only the
    # CHF posting and currency=USD matches only the cash/equity postings —
    # no single posting satisfies both, so this must NOT be returned.
    create_transaction(
        client,
        "2026-01-01",
        [
            {"account": brokerage["name"], "units": {"amount": "-50", "symbol": "CHF"}},
            {"account": other["name"], "units": {"amount": "50", "symbol": "USD"}},
            {"account": equity["name"]},
        ],
    )

    response = client.get("/transactions?account_name=Assets:Broker&currency=USD")

    assert response.status_code == 200
    assert response.json()["transactions"] == []


def test_list_transactions_currency_filter_no_match_returns_empty() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "-100", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "100", "symbol": "CHF"}},
        ],
    )

    response = client.get("/transactions?currency=USD")

    assert response.status_code == 200
    assert response.json()["transactions"] == []


def test_list_transactions_rejects_account_and_account_name_together() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking")

    response = client.get(f"/transactions?account={checking['name']}&account_name=Assets:Bank")

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "conflicting_account_filters"


# ---------------------------------------------------------------------------
# merge transactions
# ---------------------------------------------------------------------------


def test_merge_combines_postings_and_source_ids() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    savings = create_account(client, "Assets:Savings")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "-50000.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "50000.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:transfer:123"],
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": savings["name"], "units": {"amount": "50000.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-50000.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:transfer:456"],
    )

    response = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )

    assert response.status_code == 200
    merged = response.json()
    assert merged["name"] not in {primary["name"], secondary["name"]}
    assert len(merged["postings"]) == 4
    account_names = {p["account"] for p in merged["postings"]}
    assert checking["name"] in account_names
    assert savings["name"] in account_names
    assert merged["import_metadata"]["source_native_ids"] == [
        "ibkr:transfer:123",
        "zkb:transfer:456",
    ]

    # Originals are NOT deleted
    assert client.get(f"/{primary['name']}").status_code == 200
    assert client.get(f"/{secondary['name']}").status_code == 200


def test_merge_deduplicates_identical_postings() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:dup:1"],
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:dup:2"],
    )

    response = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )

    assert response.status_code == 200
    merged = response.json()
    assert len(merged["postings"]) == 2


def test_merge_narration_rules() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {
                "account": checking["name"],
                "units": {"amount": "100.00", "symbol": "CHF"},
                "narration": None,
            },
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:nar:1"],
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {
                "account": checking["name"],
                "units": {"amount": "100.00", "symbol": "CHF"},
                "narration": "Transfer in",
            },
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:nar:2"],
    )

    response = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )

    assert response.status_code == 200
    merged = response.json()
    assert len(merged["postings"]) == 2
    checking_posting = next(p for p in merged["postings"] if p["account"] == checking["name"])
    assert checking_posting["narration"] == "Transfer in"


def test_merge_primary_narration_wins_when_both_set() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {
                "account": checking["name"],
                "units": {"amount": "100.00", "symbol": "CHF"},
                "narration": "IB label",
            },
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:narwin:1"],
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {
                "account": checking["name"],
                "units": {"amount": "100.00", "symbol": "CHF"},
                "narration": "ZKB label",
            },
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:narwin:2"],
    )

    response = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )

    assert response.status_code == 200
    merged = response.json()
    assert len(merged["postings"]) == 2
    checking_posting = next(p for p in merged["postings"] if p["account"] == checking["name"])
    assert checking_posting["narration"] == "IB label"


def test_merge_payee_fills_from_secondary_when_primary_empty() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:payee1:1"],
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:payee1:2"],
        payee="ZKB Bank",
    )

    response = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )

    assert response.status_code == 200
    assert response.json()["payee"] == "ZKB Bank"


def test_merge_payee_primary_wins_when_both_set() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:payee2:1"],
        payee="IBKR",
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:payee2:2"],
        payee="ZKB Bank",
    )

    response = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )

    assert response.status_code == 200
    assert response.json()["payee"] == "IBKR"


def test_merge_secondary_source_id_blocks_reimport() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:reimport:1"],
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:reimport:2"],
    )

    client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )

    # Re-importing the secondary source ID conflicts (merged tx holds combined IDs)
    response = client.post(
        "/transactions",
        json={
            "transaction": {
                "transaction_date": "2026-06-15",
                "postings": [
                    {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
                    {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
                ],
                "import_metadata": {"source_native_ids": ["zkb:reimport:2"]},
            }
        },
    )
    assert response.status_code == 409


def test_merge_originals_unchanged_after_merge() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:orig:1"],
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:orig:2"],
    )

    merged_resp = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )
    assert merged_resp.status_code == 200
    merged = merged_resp.json()

    # Merged is a new transaction
    assert merged["name"] not in {primary["name"], secondary["name"]}
    # Originals are untouched
    primary_after = client.get(f"/{primary['name']}").json()
    secondary_after = client.get(f"/{secondary['name']}").json()
    assert primary_after["import_metadata"]["source_native_ids"] == ["ibkr:orig:1"]
    assert secondary_after["import_metadata"]["source_native_ids"] == ["zkb:orig:2"]


def test_merge_originals_can_be_deleted_after_merge() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking")
    equity = create_account(client, "Equity:Opening")
    create_commodity(client, "CHF")

    primary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["ibkr:del:1"],
    )
    secondary = create_transaction(
        client,
        "2026-06-15",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
        source_native_ids=["zkb:del:2"],
    )

    merged_resp = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )
    merged_name = merged_resp.json()["name"]

    assert client.delete(f"/{primary['name']}").status_code == 204
    assert client.delete(f"/{secondary['name']}").status_code == 204
    assert client.get(f"/{merged_name}").status_code == 200


def test_list_transactions_last_import() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking:LI")
    equity = create_account(client, "Equity:Opening:LI")
    create_commodity(client, "CHF")

    postings = [
        {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
        {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
    ]

    create_transaction(client, "2026-01-01", postings, import_timestamp="2026-01-01T10:00:00")
    b = create_transaction(client, "2026-01-02", postings, import_timestamp="2026-01-02T10:00:00")

    resp = client.get("/transactions?last_import=true")
    assert resp.status_code == 200
    names = [t["name"] for t in resp.json()["transactions"]]
    assert names == [b["name"]]


def test_list_transactions_last_import_no_imports() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking:LINI")
    equity = create_account(client, "Equity:Opening:LINI")
    create_commodity(client, "CHF")

    create_transaction(
        client,
        "2026-01-01",
        [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
    )

    resp = client.get("/transactions?last_import=true")
    assert resp.status_code == 200
    assert resp.json()["transactions"] == []


def test_merge_transactions_import_timestamp() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking:MTS")
    equity = create_account(client, "Equity:Opening:MTS")
    create_commodity(client, "CHF")

    postings = [
        {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
        {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
    ]

    primary = create_transaction(
        client,
        "2026-01-01",
        postings,
        source_native_ids=["mts:1"],
        import_timestamp="2026-01-01T10:00:00",
    )
    secondary = create_transaction(
        client,
        "2026-01-01",
        postings,
        source_native_ids=["mts:2"],
        import_timestamp="2026-01-02T10:00:00",
    )

    merged_resp = client.post(
        "/transactions:merge",
        json={"primary_transaction": primary["name"], "secondary_transaction": secondary["name"]},
    )
    assert merged_resp.status_code == 200
    merged = merged_resp.json()

    assert merged["import_metadata"]["import_timestamp"] == "2026-01-02T10:00:00"


def test_list_transactions_last_import_combined_with_account() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Checking:LICA")
    savings = create_account(client, "Assets:Savings:LICA")
    equity = create_account(client, "Equity:Opening:LICA")
    create_commodity(client, "CHF")

    def checking_posting():
        return [
            {"account": checking["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ]

    def savings_posting():
        return [
            {"account": savings["name"], "units": {"amount": "200.00", "symbol": "CHF"}},
            {"account": equity["name"], "units": {"amount": "-200.00", "symbol": "CHF"}},
        ]

    # Batch 1: one checking, one savings
    create_transaction(
        client, "2026-01-01", checking_posting(), import_timestamp="2026-01-01T10:00:00"
    )
    create_transaction(
        client, "2026-01-01", savings_posting(), import_timestamp="2026-01-01T10:00:00"
    )

    # Batch 2: one checking, one savings
    checking_b2 = create_transaction(
        client, "2026-01-02", checking_posting(), import_timestamp="2026-01-02T10:00:00"
    )
    create_transaction(
        client, "2026-01-02", savings_posting(), import_timestamp="2026-01-02T10:00:00"
    )

    # last_import + account_name filter → only checking from batch 2
    resp = client.get("/transactions?last_import=true&account_name=Assets:Checking:LICA")
    assert resp.status_code == 200
    names = [t["name"] for t in resp.json()["transactions"]]
    assert names == [checking_b2["name"]]
