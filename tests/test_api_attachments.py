from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


def make_client(monkeypatch: pytest.MonkeyPatch, api_token: str = "test-token") -> TestClient:
    from family_ledger import config as config_module

    monkeypatch.setenv("FAMILY_LEDGER_PAPERLESS_BASE_URL", "https://paperless.example.com")
    monkeypatch.setenv("FAMILY_LEDGER_PAPERLESS_TOKEN", "paperless-token")
    monkeypatch.setenv("FAMILY_LEDGER_ATTACHMENT_POLLER_ENABLED", "false")
    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    return TestClient(
        main_module.create_app(),
        headers={"Authorization": f"Bearer {api_token}"},
    )


def create_account(client: TestClient) -> str:
    response = client.post(
        "/accounts",
        json={
            "account": {
                "account_name": "Assets:Bank:Checking",
                "effective_start_date": "2020-01-01",
            }
        },
    )
    assert response.status_code == 201
    return response.json()["name"]


def test_create_attachment_returns_public_resource_only(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger.services import paperless

    monkeypatch.setattr(paperless, "upload_document", lambda *args, **kwargs: "task-123")
    client = make_client(monkeypatch)
    account = create_account(client)

    response = client.post(
        "/attachments",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
        data={
            "account": account,
            "attachment_date": "2026-05-19",
            "title": "May statement",
            "entity_metadata": '{"source": "bank"}',
        },
    )

    assert response.status_code == 202
    body = response.json()
    assert body == {
        "name": body["name"],
        "account": account,
        "attachment_date": "2026-05-19",
        "original_filename": "statement.pdf",
        "media_type": "application/pdf",
        "status": "pending_storage",
        "document_url": None,
        "entity_metadata": {"source": "bank"},
    }
    assert body["name"].startswith("attachments/att_")
    assert "storage_metadata" not in body
    assert "storage_backend" not in body


def test_create_attachment_rejects_invalid_entity_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    response = client.post(
        "/attachments",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
        data={
            "account": account,
            "attachment_date": "2026-05-19",
            "entity_metadata": "not-json",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_entity_metadata"


def test_create_attachment_rejects_non_object_entity_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    response = client.post(
        "/attachments",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
        data={
            "account": account,
            "attachment_date": "2026-05-19",
            "entity_metadata": '"not-an-object"',
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_entity_metadata"


def test_create_attachment_requires_existing_account(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger.services import paperless

    monkeypatch.setattr(paperless, "upload_document", lambda *args, **kwargs: "task-123")
    client = make_client(monkeypatch)

    response = client.post(
        "/attachments",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
        data={
            "account": "accounts/missing",
            "attachment_date": "2026-05-19",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "account_not_found"


def test_create_attachment_returns_503_when_paperless_upload_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger.services import paperless
    from family_ledger.services.errors import UnavailableError

    def raise_unavailable(*args, **kwargs):
        raise UnavailableError(code="paperless_unreachable", message="Paperless is unreachable")

    monkeypatch.setattr(paperless, "upload_document", raise_unavailable)
    client = make_client(monkeypatch)
    account = create_account(client)

    response = client.post(
        "/attachments",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
        data={
            "account": account,
            "attachment_date": "2026-05-19",
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "paperless_unreachable"


def test_get_and_list_attachments(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger.services import paperless

    monkeypatch.setattr(paperless, "upload_document", lambda *args, **kwargs: "task-123")
    client = make_client(monkeypatch)
    account = create_account(client)

    create_response = client.post(
        "/attachments",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
        data={
            "account": account,
            "attachment_date": "2026-05-19",
        },
    )
    assert create_response.status_code == 202
    attachment_name = create_response.json()["name"]

    get_response = client.get(f"/{attachment_name}")
    assert get_response.status_code == 200
    assert get_response.json()["name"] == attachment_name

    list_response = client.get("/attachments")
    assert list_response.status_code == 200
    assert list_response.json() == {
        "attachments": [get_response.json()],
        "next_page_token": None,
    }


def test_attachment_routes_require_authentication(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger import config as config_module

    monkeypatch.setenv("FAMILY_LEDGER_PAPERLESS_BASE_URL", "https://paperless.example.com")
    monkeypatch.setenv("FAMILY_LEDGER_PAPERLESS_TOKEN", "paperless-token")
    monkeypatch.setenv("FAMILY_LEDGER_ATTACHMENT_POLLER_ENABLED", "false")
    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    client = TestClient(main_module.create_app())

    response = client.get("/attachments")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthenticated"
