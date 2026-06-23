from __future__ import annotations

import contextlib
import importlib
from collections.abc import Iterator

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


def create_transaction(
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


def create_balance_assertion(
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


def pad(client: TestClient, account_name: str, pad_date: str) -> dict:
    response = client.get(f"/{account_name}:pad?date={pad_date}")
    assert response.status_code == 200
    return response.json()
