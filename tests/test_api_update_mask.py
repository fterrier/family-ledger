"""update_mask is required on every PATCH endpoint and only the masked fields are written.

Without a mask a PATCH used to be a full replace, silently wiping fields the client didn't
send (e.g. a mobile edit dropping a transaction's import_metadata, which broke importer
dedup on the next re-import).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from api_helpers import make_client
from fastapi.testclient import TestClient

from family_ledger.importers.base import BaseImporter, ImportResult


class _FakeImporter(BaseImporter):
    name = "fake"
    display_name = "Fake Importer"

    def execute(self, ctx, files, config, settings=None) -> ImportResult:  # type: ignore[override]
        return ImportResult()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr("family_ledger.importers.registry._importers", {"fake": _FakeImporter})
    return make_client()


def _path(name: str) -> str:
    # Resource names are camelCase ("balanceAssertions/bal_x"); URLs are kebab-case.
    return "/" + name.replace("balanceAssertions/", "balance-assertions/")


def _post(client: TestClient, path: str, body: dict[str, Any]) -> dict[str, Any]:
    response = client.post(path, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _account(client: TestClient, account_name: str = "Assets:Bank:Checking") -> str:
    return _post(
        client,
        "/accounts",
        {"account": {"account_name": account_name, "effective_start_date": "2020-01-01"}},
    )["name"]


def _commodity(client: TestClient, symbol: str) -> str:
    return _post(client, "/commodities", {"commodity": {"symbol": symbol}})["name"]


# Each factory creates the resource and returns (resource name, request key, full body).
Factory = Callable[[TestClient], tuple[str, str, dict[str, Any]]]


def _make_account(client: TestClient) -> tuple[str, str, dict[str, Any]]:
    body = {
        "account_name": "Assets:Bank:Savings",
        "effective_start_date": "2020-01-01",
        "entity_metadata": {"source": "bank"},
    }
    return _post(client, "/accounts", {"account": body})["name"], "account", body


def _make_commodity(client: TestClient) -> tuple[str, str, dict[str, Any]]:
    body = {"symbol": "ABC", "ticker": "ABC.SW", "entity_metadata": {"source": "yahoo"}}
    return _post(client, "/commodities", {"commodity": body})["name"], "commodity", body


def _make_price(client: TestClient) -> tuple[str, str, dict[str, Any]]:
    _commodity(client, "CHF")
    _commodity(client, "USD")
    body = {
        "price_date": "2026-01-01",
        "base_symbol": "USD",
        "quote": {"amount": "0.90", "symbol": "CHF"},
        "entity_metadata": {"source": "ecb"},
    }
    return _post(client, "/prices", {"price": body})["name"], "price", body


def _make_balance_assertion(client: TestClient) -> tuple[str, str, dict[str, Any]]:
    _commodity(client, "CHF")
    body = {
        "assertion_date": "2026-01-01",
        "account": _account(client),
        "amount": {"amount": "100.00", "symbol": "CHF"},
        "entity_metadata": {"source": "bank"},
    }
    name = _post(client, "/balance-assertions", {"balance_assertion": body})["name"]
    return name, "balance_assertion", body


def _make_attachment(client: TestClient) -> tuple[str, str, dict[str, Any]]:
    body = {
        "account": _account(client),
        "attachment_date": "2026-01-01",
        "original_filename": "statement.pdf",
        "media_type": "application/pdf",
        "entity_metadata": {"viseca": {}},
    }
    return _post(client, "/attachments", {"attachment": body})["name"], "attachment", body


def _make_transaction(client: TestClient) -> tuple[str, str, dict[str, Any]]:
    _commodity(client, "CHF")
    checking = _account(client)
    food = _account(client, "Expenses:Food")
    body = {
        "transaction_date": "2026-01-01",
        "payee": "Migros",
        "tags": ["groceries"],
        "entity_metadata": {"viseca": {}},
        "import_metadata": {"source_native_ids": ["viseca:abc"]},
        "postings": [
            {"account": checking, "units": {"amount": "-10.00", "symbol": "CHF"}},
            {"account": food, "units": {"amount": "10.00", "symbol": "CHF"}},
        ],
    }
    return _post(client, "/transactions", {"transaction": body})["name"], "transaction", body


def _make_importer(client: TestClient) -> tuple[str, str, dict[str, Any]]:
    return "importers/fake", "importer", {"config": {"key": "value"}}


FACTORIES: dict[str, Factory] = {
    "account": _make_account,
    "commodity": _make_commodity,
    "price": _make_price,
    "balance_assertion": _make_balance_assertion,
    "attachment": _make_attachment,
    "transaction": _make_transaction,
    "importer": _make_importer,
}


@pytest.mark.parametrize("kind", FACTORIES)
def test_patch_without_update_mask_is_rejected(client: TestClient, kind: str) -> None:
    name, key, body = FACTORIES[kind](client)

    response = client.patch(_path(name), json={key: body})

    assert response.status_code == 422, response.text


@pytest.mark.parametrize("kind", FACTORIES)
@pytest.mark.parametrize("mask", ["", " , ", "not_a_field"])
def test_patch_with_invalid_update_mask_is_rejected(
    client: TestClient, kind: str, mask: str
) -> None:
    name, key, body = FACTORIES[kind](client)

    response = client.patch(_path(name), json={key: body, "update_mask": mask})

    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == "invalid_update_mask"


# (kind, update_mask, field changes sent in the body, fields that must keep their old value)
PARTIAL_UPDATES = [
    (
        "account",
        "account_name",
        {"account_name": "Assets:Bank:Renamed", "entity_metadata": {}},
        ["entity_metadata", "effective_start_date"],
    ),
    (
        "commodity",
        "ticker",
        {"symbol": "XYZ", "ticker": "XYZ.SW", "entity_metadata": {}},
        ["symbol", "entity_metadata"],
    ),
    (
        "price",
        "quote",
        {"price_date": "2026-02-02", "quote": {"amount": "0.9500000000", "symbol": "CHF"}},
        ["price_date", "entity_metadata"],
    ),
    (
        "balance_assertion",
        "amount",
        {
            "assertion_date": "2026-02-02",
            "amount": {"amount": "200.00", "symbol": "CHF"},
            "entity_metadata": {},
        },
        ["assertion_date", "entity_metadata"],
    ),
    (
        "attachment",
        "original_filename",
        {"original_filename": "renamed.pdf", "media_type": None, "entity_metadata": {}},
        ["media_type", "entity_metadata"],
    ),
    (
        "transaction",
        "payee",
        {"payee": "Coop", "tags": [], "entity_metadata": {}, "import_metadata": None},
        ["tags", "entity_metadata", "import_metadata"],
    ),
]


@pytest.mark.parametrize(
    ("kind", "mask", "changes", "preserved"),
    PARTIAL_UPDATES,
    ids=[case[0] for case in PARTIAL_UPDATES],
)
def test_patch_writes_only_masked_fields(
    client: TestClient,
    kind: str,
    mask: str,
    changes: dict[str, Any],
    preserved: list[str],
) -> None:
    name, key, body = FACTORIES[kind](client)
    before = client.get(_path(name)).json()

    response = client.patch(_path(name), json={key: {**body, **changes}, "update_mask": mask})

    assert response.status_code == 200, response.text
    after = response.json()
    for field in mask.split(","):
        assert after[field] == changes[field]
    for field in preserved:
        assert after[field] == before[field], field


def test_patch_entity_metadata_is_written_when_masked(client: TestClient) -> None:
    # commodity and price used to ignore entity_metadata on update altogether
    for kind in ("commodity", "price"):
        name, key, body = FACTORIES[kind](client)

        response = client.patch(
            f"/{name}",
            json={
                key: {**body, "entity_metadata": {"edited": True}},
                "update_mask": "entity_metadata",
            },
        )

        assert response.status_code == 200, response.text
        assert response.json()["entity_metadata"] == {"edited": True}
