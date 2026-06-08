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


def test_create_attachment_without_url_returns_pending_upload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    response = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
                "media_type": "application/pdf",
                "entity_metadata": {"source": "bank"},
            }
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body == {
        "name": body["name"],
        "account": account,
        "attachment_date": "2026-05-19",
        "original_filename": "statement.pdf",
        "media_type": "application/pdf",
        "status": "pending_upload",
        "document_url": None,
        "entity_metadata": {"source": "bank"},
    }
    assert body["name"].startswith("attachments/att_")
    assert "storage_metadata" not in body
    assert "storage_backend" not in body


def test_create_attachment_with_url_returns_stored(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    response = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
                "document_url": "https://paperless.example.com/documents/42",
            }
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "stored"
    assert body["document_url"] == "https://paperless.example.com/documents/42"


def test_create_attachment_duplicate_returns_409(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)
    payload = {
        "attachment": {
            "account": account,
            "attachment_date": "2026-05-19",
            "original_filename": "statement.pdf",
        }
    }

    first = client.post("/attachments", json=payload)
    assert first.status_code == 201

    second = client.post("/attachments", json=payload)
    assert second.status_code == 409


def test_create_attachment_requires_existing_account(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)

    response = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": "accounts/missing",
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "account_not_found"


def test_upload_attachment_transitions_to_pending_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger.services import paperless

    monkeypatch.setattr(paperless, "upload_document", lambda *args, **kwargs: "task-123")
    client = make_client(monkeypatch)
    account = create_account(client)

    create_resp = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
                "media_type": "application/pdf",
            }
        },
    )
    assert create_resp.status_code == 201
    assert create_resp.json()["status"] == "pending_upload"
    attachment_name = create_resp.json()["name"]

    upload_resp = client.post(
        f"/{attachment_name}:upload",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
    )

    assert upload_resp.status_code == 202
    body = upload_resp.json()
    assert body["status"] == "pending_storage"
    assert body["document_url"] is None


def test_upload_attachment_returns_503_when_paperless_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger.services import paperless
    from family_ledger.services.errors import UnavailableError

    def raise_unavailable(*args, **kwargs):
        raise UnavailableError(code="paperless_unreachable", message="Paperless is unreachable")

    monkeypatch.setattr(paperless, "upload_document", raise_unavailable)
    client = make_client(monkeypatch)
    account = create_account(client)

    create_resp = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
            }
        },
    )
    assert create_resp.status_code == 201
    attachment_name = create_resp.json()["name"]

    upload_resp = client.post(
        f"/{attachment_name}:upload",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
    )

    assert upload_resp.status_code == 503
    assert upload_resp.json()["detail"]["code"] == "paperless_unreachable"


def test_upload_attachment_returns_404_for_unknown_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch)

    response = client.post(
        "/attachments/att_nonexistent:upload",
        files={"file": ("statement.pdf", b"pdf-data", "application/pdf")},
    )

    assert response.status_code == 404


def test_get_and_list_attachments(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    create_response = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
            }
        },
    )
    assert create_response.status_code == 201
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


def test_patch_attachment_updates_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    create_resp = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "old.pdf",
            }
        },
    )
    assert create_resp.status_code == 201
    name = create_resp.json()["name"]

    patch_resp = client.patch(
        f"/{name}",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-06-01",
                "original_filename": "new.pdf",
                "entity_metadata": {"k": "v"},
            }
        },
    )

    assert patch_resp.status_code == 200
    body = patch_resp.json()
    assert body["attachment_date"] == "2026-06-01"
    assert body["original_filename"] == "new.pdf"
    assert body["entity_metadata"] == {"k": "v"}
    assert body["status"] == "pending_upload"


def test_patch_attachment_with_document_url_sets_stored(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    create_resp = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
            }
        },
    )
    name = create_resp.json()["name"]

    patch_resp = client.patch(
        f"/{name}",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
                "document_url": "https://paperless.example.com/documents/42",
            }
        },
    )

    assert patch_resp.status_code == 200
    assert patch_resp.json()["status"] == "stored"
    assert patch_resp.json()["document_url"] == "https://paperless.example.com/documents/42"


def test_patch_attachment_returns_404_for_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    response = client.patch(
        "/attachments/att_missing",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "x.pdf",
            }
        },
    )

    assert response.status_code == 404


def test_delete_attachment_removes_record(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    create_resp = client.post(
        "/attachments",
        json={
            "attachment": {
                "account": account,
                "attachment_date": "2026-05-19",
                "original_filename": "statement.pdf",
            }
        },
    )
    assert create_resp.status_code == 201
    name = create_resp.json()["name"]

    delete_resp = client.delete(f"/{name}")
    assert delete_resp.status_code == 204

    get_resp = client.get(f"/{name}")
    assert get_resp.status_code == 404


def test_delete_attachment_returns_404_for_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)

    response = client.delete("/attachments/att_missing")

    assert response.status_code == 404


def test_list_attachments_ordered_by_date_ascending(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch)
    account = create_account(client)

    for attachment_date in ["2026-03-01", "2026-01-01", "2026-02-01"]:
        client.post(
            "/attachments",
            json={
                "attachment": {
                    "account": account,
                    "attachment_date": attachment_date,
                    "original_filename": f"{attachment_date}.pdf",
                }
            },
        )

    response = client.get("/attachments")

    assert response.status_code == 200
    dates = [a["attachment_date"] for a in response.json()["attachments"]]
    assert dates == ["2026-01-01", "2026-02-01", "2026-03-01"]


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
