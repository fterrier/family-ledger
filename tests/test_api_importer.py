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

    def execute(
        self, session: Session, file_data: bytes, config: dict, settings: object = None
    ) -> ImportResult:  # type: ignore[override]
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

    def execute(
        self, session: Session, file_data: bytes, config: dict, settings: object = None
    ) -> ImportResult:  # type: ignore[override]
        return ImportResult()


class _CapturingSchemaImporter(_SchemaImporter):
    last_config: dict[str, Any] | None = None

    def execute(
        self, session: Session, file_data: bytes, config: dict, settings: object = None
    ) -> ImportResult:  # type: ignore[override]
        _CapturingSchemaImporter.last_config = dict(config)
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


def test_list_importers_works_without_db_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """Registry-driven list works even when no config rows exist in the DB."""
    client = make_client(monkeypatch, {"fake": _FakeImporter})

    response = client.get("/importers")

    assert response.status_code == 200
    assert response.json()["importers"][0]["config"] == {}


def test_list_importers_requires_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("family_ledger.importers.registry._importers", {})
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    client = TestClient(main_module.create_app())

    response = client.get("/importers")

    assert response.status_code == 401


def test_update_importer_config(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})

    response = client.patch(
        "/importers/fake",
        json={"importer": {"config": {"key": "value"}}},
    )

    assert response.status_code == 200
    assert response.json()["config"] == {"key": "value"}


def test_update_importer_config_validates_against_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"schema_fake": _SchemaImporter})

    response = client.patch(
        "/importers/schema_fake",
        json={"importer": {"config": {"api_key": "secret"}}},
    )

    assert response.status_code == 200
    assert response.json()["config"] == {"api_key": "secret"}


def test_update_importer_config_rejects_invalid_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"schema_fake": _SchemaImporter})

    response = client.patch(
        "/importers/schema_fake",
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

    response = client.post(
        "/importers/fake:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
    )

    assert response.status_code == 200
    body = response.json()
    assert "result" in body
    assert body["result"]["entities"] == {}
    assert body["result"]["warnings"] == []


def test_run_import_accepts_config_override(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})

    response = client.post(
        "/importers/fake:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
        data={"config_override": '{"extra": "val"}'},
    )

    assert response.status_code == 200


def test_run_import_merges_override_over_stored_config(monkeypatch: pytest.MonkeyPatch) -> None:
    _CapturingSchemaImporter.last_config = None
    client = make_client(monkeypatch, {"schema_fake": _CapturingSchemaImporter})

    update_response = client.patch(
        "/importers/schema_fake",
        json={"importer": {"config": {"api_key": "stored"}}},
    )
    assert update_response.status_code == 200

    response = client.post(
        "/importers/schema_fake:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
        data={"config_override": '{"api_key": "override"}'},
    )

    assert response.status_code == 200
    assert _CapturingSchemaImporter.last_config == {"api_key": "override"}


def test_run_import_rejects_invalid_json_config_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})

    response = client.post(
        "/importers/fake:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
        data={"config_override": "not-json"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_config_override"


def test_run_import_rejects_non_object_config_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"fake": _FakeImporter})

    response = client.post(
        "/importers/fake:import",
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


def test_run_import_rejects_invalid_merged_config_without_wiping_stored_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, {"schema_fake": _SchemaImporter})

    update_response = client.patch(
        "/importers/schema_fake",
        json={"importer": {"config": {"api_key": "stored"}}},
    )
    assert update_response.status_code == 200

    response = client.post(
        "/importers/schema_fake:import",
        files={"file": ("data.txt", b"hello", "text/plain")},
        data={"config_override": '{"unknown_field": "bad"}'},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_config"

    importer = client.get("/importers").json()["importers"][0]
    assert importer["config"] == {"api_key": "stored"}
