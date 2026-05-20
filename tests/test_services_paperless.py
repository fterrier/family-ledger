from __future__ import annotations

from datetime import date

import httpx
import pytest

from family_ledger.config import Settings
from family_ledger.services import paperless


def test_upload_document_includes_configured_tag_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> str:
            return "task-123"

    def fake_post(url: str, *, headers, files, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["files"] = files
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(httpx, "post", fake_post)

    task_id = paperless.upload_document(
        Settings(
            api_token="test-token",
            paperless_base_url="https://paperless.example.com",
            paperless_token="paperless-token",
            paperless_tag_ids=[12, 34],
        ),
        filename="statement.pdf",
        content_type="application/pdf",
        file_data=b"pdf-data",
        created=date(2026, 5, 20),
        title="May statement",
    )

    assert task_id == "task-123"
    assert captured["url"] == "https://paperless.example.com/api/documents/post_document/"
    assert captured["files"] == [
        ("document", ("statement.pdf", b"pdf-data", "application/pdf")),
        ("created", (None, "2026-05-20")),
        ("title", (None, "May statement")),
        ("tags", (None, "12")),
        ("tags", (None, "34")),
    ]


def test_add_tags_to_document_calls_bulk_edit_once_per_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

    def fake_post(url: str, *, headers, json, timeout):
        calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return FakeResponse()

    monkeypatch.setattr(httpx, "post", fake_post)

    paperless.add_tags_to_document(
        Settings(
            api_token="test-token",
            paperless_base_url="https://paperless.example.com",
            paperless_token="paperless-token",
        ),
        84,
        [12, 34],
    )

    assert calls == [
        {
            "url": "https://paperless.example.com/api/documents/bulk_edit/",
            "headers": {
                "Authorization": "Token paperless-token",
                "Accept": "application/json; version=10",
            },
            "json": {
                "documents": [84],
                "method": "add_tag",
                "parameters": {"tag": 12},
            },
            "timeout": paperless.REQUEST_TIMEOUT_SECONDS,
        },
        {
            "url": "https://paperless.example.com/api/documents/bulk_edit/",
            "headers": {
                "Authorization": "Token paperless-token",
                "Accept": "application/json; version=10",
            },
            "json": {
                "documents": [84],
                "method": "add_tag",
                "parameters": {"tag": 34},
            },
            "timeout": paperless.REQUEST_TIMEOUT_SECONDS,
        },
    ]


def test_settings_parse_paperless_tag_ids_from_csv() -> None:
    settings = Settings.model_validate(
        {
            "api_token": "test-token",
            "paperless_base_url": "https://paperless.example.com",
            "paperless_token": "paperless-token",
            "paperless_tag_ids": "12, 34,56",
        }
    )

    assert settings.paperless_tag_ids == [12, 34, 56]


def test_settings_reject_invalid_paperless_tag_ids() -> None:
    with pytest.raises(ValueError, match="paperless_tag_ids"):
        Settings.model_validate(
            {
                "api_token": "test-token",
                "paperless_base_url": "https://paperless.example.com",
                "paperless_token": "paperless-token",
                "paperless_tag_ids": "12, nope",
            }
        )


def test_get_task_result_supports_legacy_list_response(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self):
            return [
                {
                    "task_id": "task-123",
                    "status": "SUCCESS",
                    "result": "Success. New document id 2217 created",
                    "related_document": "2217",
                }
            ]

    monkeypatch.setattr(httpx, "get", lambda *args, **kwargs: FakeResponse())

    result = paperless.get_task_result(
        Settings(
            api_token="test-token",
            paperless_base_url="https://paperless.example.com",
            paperless_token="paperless-token",
        ),
        "task-123",
    )

    assert result == paperless.PaperlessTaskResult(
        status="success",
        document_id=2217,
        duplicate_of=None,
        error_code="success",
        error_message="Success. New document id 2217 created",
    )
