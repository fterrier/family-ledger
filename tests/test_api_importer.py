from __future__ import annotations

import importlib
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from family_ledger.importers.base import BaseImporter, ImportResult


class _FakeImporter(BaseImporter):
    name = "fake"
    display_name = "Fake Importer"

    def execute(self, session: Session, file_data: bytes, config: dict) -> ImportResult:  # type: ignore[override]
        return ImportResult()


class _SchemaImporter(BaseImporter):
    name = "schema_fake"
    display_name = "Schema Fake Importer"

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"api_key": {"type": "string"}},
            "required": ["api_key"],
            "additionalProperties": False,
        }

    def execute(self, session: Session, file_data: bytes, config: dict) -> ImportResult:  # type: ignore[override]
        return ImportResult()


def make_client(
    monkeypatch: pytest.MonkeyPatch,
    importers: dict,
    api_token: str = "test-token",
) -> TestClient:
    monkeypatch.setattr("family_ledger.importers.registry._importers", importers)
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    return TestClient(
        main_module.create_app(),
        headers={"Authorization": f"Bearer {api_token}"},
    )


def test_list_importers_returns_registered_importers(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})

    response = client.get("/importers")

    assert response.status_code == 200
    body = response.json()
    assert len(body["importers"]) == 1
    assert body["importers"][0]["plugin_name"] == "fake"
    assert body["importers"][0]["display_name"] == "Fake Importer"
    assert body["importers"][0]["config"] == {}
    assert body["importers"][0]["schema"] == {}


def test_list_importers_returns_empty_when_none_registered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {})

    response = client.get("/importers")

    assert response.status_code == 200
    assert response.json()["importers"] == []


def test_list_importers_requires_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("family_ledger.importers.registry._importers", {})
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    client = TestClient(main_module.create_app())

    response = client.get("/importers")

    assert response.status_code == 401


def test_update_importer_config(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})
    importer_name = client.get("/importers").json()["importers"][0]["name"]

    response = client.patch(
        f"/{importer_name}",
        json={"importer": {"config": {"key": "value"}}},
    )

    assert response.status_code == 200
    assert response.json()["config"] == {"key": "value"}


def test_update_importer_config_validates_against_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"schema_fake": _SchemaImporter})
    importer_name = client.get("/importers").json()["importers"][0]["name"]

    response = client.patch(
        f"/{importer_name}",
        json={"importer": {"config": {"api_key": "secret"}}},
    )

    assert response.status_code == 200
    assert response.json()["config"] == {"api_key": "secret"}


def test_update_importer_config_rejects_invalid_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"schema_fake": _SchemaImporter})
    importer_name = client.get("/importers").json()["importers"][0]["name"]

    response = client.patch(
        f"/{importer_name}",
        json={"importer": {"config": {"unknown_field": "bad"}}},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_config"


def test_update_importer_returns_404_for_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, {})

    response = client.patch(
        "/importers/missing",
        json={"importer": {"config": {}}},
    )

    assert response.status_code == 404


def test_run_import_returns_result(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})
    importer_name = client.get("/importers").json()["importers"][0]["name"]

    response = client.post(
        f"/{importer_name}:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
    )

    assert response.status_code == 200
    body = response.json()
    assert "result" in body
    assert body["result"]["entities"] == {}
    assert body["result"]["warnings"] == []


def test_run_import_accepts_config_override(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})
    importer_name = client.get("/importers").json()["importers"][0]["name"]

    response = client.post(
        f"/{importer_name}:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
        data={"config_override": '{"extra": "val"}'},
    )

    assert response.status_code == 200


def test_run_import_rejects_invalid_json_config_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})
    importer_name = client.get("/importers").json()["importers"][0]["name"]

    response = client.post(
        f"/{importer_name}:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
        data={"config_override": "not-json"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_config_override"


def test_run_import_rejects_non_object_config_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})
    importer_name = client.get("/importers").json()["importers"][0]["name"]

    response = client.post(
        f"/{importer_name}:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
        data={"config_override": '"just-a-string"'},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_config_override"


def test_run_import_returns_404_for_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, {})

    response = client.post(
        "/importers/missing:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
    )

    assert response.status_code == 404


def test_run_import_self_heals_stale_config(monkeypatch: pytest.MonkeyPatch) -> None:
    # Stored config that no longer matches the schema is cleared; import runs with override only.
    client = make_client(monkeypatch, {"schema_fake": _SchemaImporter})
    importer_name = client.get("/importers").json()["importers"][0]["name"]

    # Store a valid config first
    client.patch(f"/{importer_name}", json={"importer": {"config": {"api_key": "old"}}})

    # Inject a importer with a new required field to simulate schema drift.
    class _StrictImporter(_SchemaImporter):
        def get_schema(self) -> dict[str, Any]:
            return {
                "type": "object",
                "properties": {"new_field": {"type": "string"}},
                "required": ["new_field"],
                "additionalProperties": False,
            }

    monkeypatch.setattr(
        "family_ledger.importers.registry._importers", {"schema_fake": _StrictImporter}
    )

    # Override satisfies the new schema — should succeed after self-healing
    response = client.post(
        f"/{importer_name}:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
        data={"config_override": '{"new_field": "ok"}'},
    )

    assert response.status_code == 200
