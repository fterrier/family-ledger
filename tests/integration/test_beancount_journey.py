from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from family_ledger.models import Account, BalanceAssertion, Commodity, Price, Transaction

pytestmark = pytest.mark.integration

BEANCOUNT_FIXTURE = """
option "operating_currency" "CHF"

2020-01-01 open Assets:Bank:Checking:Family
2020-01-01 open Expenses:Food
2020-01-01 open Equity:Opening-Balances
2020-01-01 commodity CHF

2026-04-01 * "Migros" "Groceries"
  ref: "Z1234"
  Assets:Bank:Checking:Family  -84.25 CHF
  Expenses:Food                 84.25 CHF

2026-04-02 price CHF 1 CHF
2026-04-03 balance Assets:Bank:Checking:Family -84.25 CHF
"""


def _run_beancount_import(client: TestClient) -> dict:
    response = client.post(
        "/importers/beancount:import",
        files={"ledger_file": ("ledger.beancount", BEANCOUNT_FIXTURE.encode(), "text/plain")},
    )
    assert response.status_code == 200, response.text
    return response.json()["result"]


def test_beancount_import_creates_entities_in_postgres(
    integration_client: TestClient,
    integration_session: Session,
) -> None:
    result = _run_beancount_import(integration_client)

    assert result["entities"]["account"]["created"] == 3
    assert result["entities"]["commodity"]["created"] == 1
    assert result["entities"]["transaction"]["created"] == 1
    assert result["entities"]["price"]["created"] == 1
    assert result["entities"]["balance_assertion"]["created"] == 1
    assert result["warnings"] == []

    assert integration_session.scalar(select(func.count()).select_from(Account)) == 3
    assert integration_session.scalar(select(func.count()).select_from(Commodity)) == 1
    assert integration_session.scalar(select(func.count()).select_from(Transaction)) == 1
    assert integration_session.scalar(select(func.count()).select_from(Price)) == 1
    assert integration_session.scalar(select(func.count()).select_from(BalanceAssertion)) == 1


def test_beancount_import_is_idempotent(
    integration_client: TestClient,
    integration_session: Session,
) -> None:
    _run_beancount_import(integration_client)
    _run_beancount_import(integration_client)

    assert integration_session.scalar(select(func.count()).select_from(Transaction)) == 1
    assert integration_session.scalar(select(func.count()).select_from(Account)) == 3


def test_beancount_metadata_stored_as_jsonb(
    integration_client: TestClient,
    integration_session: Session,
) -> None:
    _run_beancount_import(integration_client)

    txn = integration_session.scalar(select(Transaction))
    assert txn is not None
    assert txn.entity_metadata == {"beancount": {"ref": "Z1234"}}

    # Verify JSONB path operator works (Postgres-specific; would fail on SQLite)
    count = integration_session.scalar(
        text(
            "SELECT COUNT(*) FROM transactions"
            " WHERE entity_metadata @> '{\"beancount\": {}}'::jsonb"
        )
    )
    assert count == 1


def test_beancount_import_then_api_read(
    integration_client: TestClient,
) -> None:
    _run_beancount_import(integration_client)

    response = integration_client.get("/transactions")
    assert response.status_code == 200
    transactions = response.json()["transactions"]
    assert len(transactions) == 1
    assert transactions[0]["payee"] == "Migros"
    assert transactions[0]["narration"] == "Groceries"

    response = integration_client.get("/accounts")
    assert response.status_code == 200
    accounts = {a["account_name"] for a in response.json()["accounts"]}
    assert accounts == {"Assets:Bank:Checking:Family", "Expenses:Food", "Equity:Opening-Balances"}
