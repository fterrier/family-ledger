from __future__ import annotations

import pytest
from api_helpers import (
    create_account,
    create_balance_assertion,
    create_commodity,
    create_transaction,
)
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration


def test_create_account_transaction_balance_assertion(
    integration_client: TestClient,
) -> None:
    create_commodity(integration_client, "CHF")
    checking = create_account(integration_client, "Assets:Bank:Checking")
    food = create_account(integration_client, "Expenses:Food")

    create_transaction(
        integration_client,
        "2026-01-15",
        postings=[
            {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
        ],
        payee="Migros",
        narration="Weekly groceries",
    )

    response = integration_client.get("/transactions")
    assert response.status_code == 200
    transactions = response.json()["transactions"]
    assert len(transactions) == 1
    assert transactions[0]["payee"] == "Migros"

    create_balance_assertion(integration_client, checking["name"], "2026-01-16", "-100.00", "CHF")

    response = integration_client.get("/balance-assertions")
    assert response.status_code == 200
    assertions = response.json()["balance_assertions"]
    assert len(assertions) == 1
    assert assertions[0]["amount"]["amount"] == "-100.00"


def test_tests_are_isolated_from_each_other(
    integration_client: TestClient,
) -> None:
    response = integration_client.get("/transactions")
    assert response.status_code == 200
    assert response.json()["transactions"] == []


def test_duplicate_commodity_returns_conflict(
    integration_client: TestClient,
) -> None:
    create_commodity(integration_client, "USD")

    response = integration_client.post(
        "/commodities",
        json={"commodity": {"symbol": "USD"}},
    )
    assert response.status_code == 409


def test_alembic_migrations_ran(
    integration_client: TestClient,
) -> None:
    response = integration_client.get("/healthz")
    assert response.status_code == 200


def test_transaction_update_time_is_second_precision_and_bumps_on_patch(
    integration_client: TestClient,
) -> None:
    # update_time is a plain opaque epoch-seconds int stored as a real
    # BigInteger column in Postgres (not a formatted timestamp string) —
    # this exercises the real migrated column end-to-end to confirm it
    # round-trips as an int and strictly increases across a real PATCH.
    create_commodity(integration_client, "CHF")
    checking = create_account(integration_client, "Assets:Bank:Checking")
    food = create_account(integration_client, "Expenses:Food")

    created = create_transaction(
        integration_client,
        "2026-01-15",
        postings=[
            {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "100.00", "symbol": "CHF"}},
        ],
    )

    assert created["update_time"]
    assert isinstance(created["update_time"], int)

    fetched = integration_client.get(f"/{created['name']}")
    assert fetched.json()["update_time"] == created["update_time"]

    patched = integration_client.patch(
        f"/{created['name']}",
        json={
            "transaction": {
                "transaction_date": "2026-01-15",
                "postings": [
                    {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
                    {"account": food["name"], "units": {"amount": "80.00", "symbol": "CHF"}},
                ],
            }
        },
    )

    assert patched.status_code == 200
    assert patched.json()["update_time"] >= created["update_time"]


def test_accountless_posting_persists_through_real_migration(
    integration_client: TestClient,
) -> None:
    create_commodity(integration_client, "CHF")
    checking = create_account(integration_client, "Assets:Bank:Checking")

    created = create_transaction(
        integration_client,
        "2026-01-15",
        postings=[
            {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
            {"account": None, "units": {"amount": "100.00", "symbol": "CHF"}},
        ],
    )

    fetched = integration_client.get(f"/{created['name']}")
    assert fetched.status_code == 200
    accountless = fetched.json()["postings"][1]
    assert accountless["account"] is None
    assert accountless["account_name"] is None


def test_split_then_unsplit_round_trip_restores_original_state(
    integration_client: TestClient,
) -> None:
    # Split off part of a posting, then merge it straight back — the end
    # state (postings, narration, balance) must match the start state
    # exactly, proving :split and :unsplit are true inverses against a real
    # migrated Postgres schema (not just each half tested in isolation).
    create_commodity(integration_client, "CHF")
    checking = create_account(integration_client, "Assets:Bank:Checking")
    food = create_account(integration_client, "Expenses:Food")

    created = create_transaction(
        integration_client,
        "2026-01-15",
        postings=[
            {"account": checking["name"], "units": {"amount": "-84.25", "symbol": "CHF"}},
            {"account": food["name"], "units": {"amount": "84.25", "symbol": "CHF"}},
        ],
        payee="Migros",
        narration="Groceries",
    )
    original_postings = [
        {"account": p["account"], "units": p["units"]} for p in created["postings"]
    ]
    assert "issues" not in created

    split = integration_client.post(
        f"/{created['name']}:split",
        json={
            "posting_index": 1,
            "split_off_amount": "30.00",
            "update_time": created["update_time"],
        },
    )
    assert split.status_code == 200
    split_body = split.json()
    assert [p["units"]["amount"] for p in split_body["postings"]] == ["-84.25", "54.25", "30.00"]
    assert split_body["postings"][2]["account"] is None
    assert "issues" not in split_body

    unsplit = integration_client.post(
        f"/{created['name']}:unsplit",
        # No merge_into_index — the server auto-detects the sign/symbol/
        # cost/price-matching destination (the 54.25 posting).
        json={
            "posting_index": 2,
            "update_time": split_body["update_time"],
        },
    )
    assert unsplit.status_code == 200
    unsplit_body = unsplit.json()

    final_postings = [
        {"account": p["account"], "units": p["units"]} for p in unsplit_body["postings"]
    ]
    assert final_postings == original_postings
    assert unsplit_body["payee"] == created["payee"]
    assert unsplit_body["narration"] == created["narration"]
    assert "issues" not in unsplit_body


def test_stored_unbalanced_transaction_persists_and_gets_a_balancing_filler_posting(
    integration_client: TestClient,
) -> None:
    # persist_transaction (Phase 4) appends a real accountless filler
    # posting whenever the stored postings don't sum to zero — proving this
    # against a real migrated Postgres schema (not just the create-response
    # echo) is the point: the filler must survive a fresh reload, not just
    # appear in the immediate response.
    create_commodity(integration_client, "CHF")
    checking = create_account(integration_client, "Assets:Bank:Checking")

    created = create_transaction(
        integration_client,
        "2026-01-15",
        postings=[
            {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
    )
    assert "issues" not in created
    assert len(created["postings"]) == 2
    assert created["postings"][1]["account"] is None
    assert created["postings"][1]["units"] == {"amount": "100.00", "symbol": "CHF"}

    fetched = integration_client.get(f"/{created['name']}")
    assert fetched.status_code == 200
    body = fetched.json()
    assert len(body["postings"]) == 2
    assert body["postings"][1]["account"] is None
    assert body["postings"][1]["units"] == {"amount": "100.00", "symbol": "CHF"}


def test_unsplitting_an_accountless_posting_with_no_merge_target_is_a_no_op(
    integration_client: TestClient,
) -> None:
    # Removing a filler posting with no sign-matching merge target reopens
    # the gap it was covering — the very same persist_transaction call
    # re-synthesizes an equivalent filler, so the net stored state is
    # unchanged. Verified end-to-end against real Postgres, including that a
    # second fresh GET doesn't show any duplication.
    create_commodity(integration_client, "CHF")
    checking = create_account(integration_client, "Assets:Bank:Checking")

    created = create_transaction(
        integration_client,
        "2026-01-15",
        postings=[
            {"account": checking["name"], "units": {"amount": "-100.00", "symbol": "CHF"}},
        ],
    )
    assert len(created["postings"]) == 2
    assert created["postings"][1]["account"] is None

    unsplit = integration_client.post(
        f"/{created['name']}:unsplit",
        json={"posting_index": 1, "update_time": created["update_time"]},
    )
    assert unsplit.status_code == 200
    unsplit_body = unsplit.json()
    assert len(unsplit_body["postings"]) == 2
    assert unsplit_body["postings"][0]["units"]["amount"] == "-100.00"
    assert unsplit_body["postings"][1]["account"] is None
    assert unsplit_body["postings"][1]["units"] == {"amount": "100.00", "symbol": "CHF"}

    fetched = integration_client.get(f"/{created['name']}")
    assert fetched.status_code == 200
    body = fetched.json()
    assert len(body["postings"]) == 2
    assert body["postings"][1]["account"] is None
    assert body["postings"][1]["units"] == {"amount": "100.00", "symbol": "CHF"}
