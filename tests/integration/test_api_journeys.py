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
