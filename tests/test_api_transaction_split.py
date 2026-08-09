from __future__ import annotations

from decimal import Decimal

from api_helpers import (
    count_sql_statements,
    create_account,
    create_commodity,
    create_transaction,
    make_client,
)


def test_split_transaction_route_is_reachable_and_produces_exact_remainder() -> None:
    # Regression for a real bug caught only at this layer: the service
    # function existed but the route was never wired up (405 Method Not
    # Allowed) until this test — the `{transaction:path}:split` route
    # pattern (a path converter followed by a literal colon-suffix) needs
    # an end-to-end check, not just a service-level unit test.
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = create_transaction(
        client,
        "2026-04-19",
        postings=[
            {"account": checking["name"], "units": {"amount": "-80.45", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "80.45", "symbol": "CHF"}},
        ],
    )

    response = client.post(
        f"/{created['name']}:split",
        json={
            "posting_index": 1,
            "split_off_amount": "0.46",
            "update_time": created["update_time"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    amounts = [Decimal(p["units"]["amount"]) for p in body["postings"]]
    assert amounts == [Decimal("-80.45"), Decimal("79.99"), Decimal("0.46")]
    assert body["postings"][2]["account"] is None
    assert "issues" not in body


def test_split_transaction_rejects_stale_update_time_with_409() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = create_transaction(
        client,
        "2026-04-19",
        postings=[
            {"account": checking["name"], "units": {"amount": "-80.45", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "80.45", "symbol": "CHF"}},
        ],
    )

    client.post(
        f"/{created['name']}:split",
        json={
            "posting_index": 1,
            "split_off_amount": "0.46",
            "update_time": created["update_time"],
        },
    )

    response = client.post(
        f"/{created['name']}:split",
        json={
            "posting_index": 1,
            "split_off_amount": "0.10",
            # Deliberately not the freshly-bumped value (unlike
            # created["update_time"], which could coincidentally still
            # match at second precision if both calls land in the same
            # wall-clock second — see plan's Known risks) — this is
            # guaranteed stale regardless of test timing (an epoch value
            # from the year 2000).
            "update_time": 946684800,
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "transaction_version_mismatch"


def test_split_transaction_rejects_out_of_range_index_with_400() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = create_transaction(
        client,
        "2026-04-19",
        postings=[
            {"account": checking["name"], "units": {"amount": "-80.45", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "80.45", "symbol": "CHF"}},
        ],
    )

    response = client.post(
        f"/{created['name']}:split",
        json={
            "posting_index": 9,
            "split_off_amount": "0.46",
            "update_time": created["update_time"],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "posting_index_out_of_range"


def test_unsplit_transaction_route_merges_postings() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    household = create_account(client, "Expenses:Household")
    create_commodity(client, "CHF")

    created = create_transaction(
        client,
        "2026-04-19",
        postings=[
            {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "60.00", "symbol": "CHF"}},
            {"account": household["name"], "units": {"amount": "40.00", "symbol": "CHF"}},
        ],
    )

    response = client.post(
        f"/{created['name']}:unsplit",
        json={"posting_index": 2, "update_time": created["update_time"]},
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body["postings"]) == 2
    assert body["postings"][1]["account"] == food["name"]
    assert Decimal(body["postings"][1]["units"]["amount"]) == Decimal("100.00")
    assert "issues" not in body


def test_unsplit_transaction_rejects_removing_accounted_posting_with_no_merge_target_with_400() -> (
    None
):
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = create_transaction(
        client,
        "2026-04-19",
        postings=[
            {"account": checking["name"], "units": {"amount": "-84.25", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "84.25", "symbol": "CHF"}},
        ],
    )

    response = client.post(
        f"/{created['name']}:unsplit",
        # No other posting shares food's sign (checking is negative) — no
        # auto-detected merge target, and an accounted posting is never
        # discarded outright.
        json={"posting_index": 1, "update_time": created["update_time"]},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "merge_target_not_found"


def test_unsplit_transaction_auto_merges_accountless_posting_into_sign_matching_destination() -> (
    None
):
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = create_transaction(
        client,
        "2026-04-19",
        postings=[
            {"account": checking["name"], "units": {"amount": "-80.45", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "79.99", "symbol": "CHF"}},
            {"account": None, "units": {"amount": "0.46", "symbol": "CHF"}},
        ],
    )

    response = client.post(
        f"/{created['name']}:unsplit",
        json={"posting_index": 2, "update_time": created["update_time"]},
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body["postings"]) == 2
    assert body["postings"][1]["account"] == food["name"]
    assert Decimal(body["postings"][1]["units"]["amount"]) == Decimal("80.45")


def test_unsplit_transaction_removing_accountless_posting_with_no_match_is_a_no_op() -> None:
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking:Family")
    create_commodity(client, "CHF")

    # Single accounted leg + its filler posting (created unbalanced on
    # purpose) — no other posting shares the filler's sign.
    created = create_transaction(
        client,
        "2026-04-19",
        postings=[
            {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
    )
    assert len(created["postings"]) == 2
    assert created["postings"][1]["account"] is None

    response = client.post(
        f"/{created['name']}:unsplit",
        json={"posting_index": 1, "update_time": created["update_time"]},
    )

    assert response.status_code == 200
    body = response.json()
    # persist_transaction re-synthesizes an equivalent filler for the
    # reopened gap — net stored state is unchanged.
    assert len(body["postings"]) == 2
    assert Decimal(body["postings"][0]["units"]["amount"]) == Decimal("-100.00")
    assert body["postings"][1]["account"] is None
    assert Decimal(body["postings"][1]["units"]["amount"]) == Decimal("100.00")
    assert body["postings"][1]["units"]["symbol"] == "CHF"


def test_split_transaction_resolves_accounts_only_once() -> None:
    # normalize_and_validate_transaction_payload already resolves+validates
    # every posting's account; persist_transaction must reuse that result
    # instead of re-querying — especially since :split holds the
    # transaction row under SELECT ... FOR UPDATE for the duration.
    client = make_client()
    checking = create_account(client, "Assets:Bank:Checking:Family")
    food = create_account(client, "Expenses:Food")
    create_commodity(client, "CHF")

    created = create_transaction(
        client,
        "2026-04-19",
        postings=[
            {"account": checking["name"], "units": {"amount": "-80.45", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "80.45", "symbol": "CHF"}},
        ],
    )

    with count_sql_statements() as statements:
        response = client.post(
            f"/{created['name']}:split",
            json={
                "posting_index": 1,
                "split_off_amount": "0.46",
                "update_time": created["update_time"],
            },
        )

    assert response.status_code == 200
    # resolve_accounts (validation.py) always looks accounts up by name, in
    # an IN(...) clause — distinct from the unrelated by-id eager-loads that
    # fetch each posting's account when the transaction row is (re)loaded.
    account_name_lookups = [s for s in statements if "accounts.name IN" in s]
    assert len(account_name_lookups) == 1
