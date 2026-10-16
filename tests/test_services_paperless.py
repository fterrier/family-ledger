from __future__ import annotations

from datetime import date
from typing import Any

import httpx
import pytest

from family_ledger.config import Settings
from family_ledger.services import paperless
from family_ledger.services.errors import UnavailableError
from family_ledger.services.paperless import extract_document_id


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


def test_require_paperless_settings_raises_when_not_configured() -> None:
    with pytest.raises(UnavailableError) as exc_info:
        paperless._require_paperless_settings(
            Settings(
                api_token="test-token",
                paperless_base_url=None,
                paperless_token=None,
            )
        )

    assert exc_info.value.code == "paperless_not_configured"


def test_upload_document_raises_on_http_status_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger.services.errors import UnavailableError

    def fake_post(*args, **kwargs):
        response = httpx.Response(503)
        raise httpx.HTTPStatusError(
            "server error", request=httpx.Request("POST", "http://x"), response=response
        )

    monkeypatch.setattr(httpx, "post", fake_post)

    with pytest.raises(UnavailableError) as exc_info:
        paperless.upload_document(
            Settings(
                api_token="test-token",
                paperless_base_url="https://paperless.example.com",
                paperless_token="tok",
            ),
            filename="f.pdf",
            content_type="application/pdf",
            file_data=b"data",
            created=date(2026, 1, 1),
            title="T",
        )

    assert exc_info.value.code == "paperless_upload_failed"


def test_upload_document_raises_on_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger.services.errors import UnavailableError

    def fake_post(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "post", fake_post)

    with pytest.raises(UnavailableError) as exc_info:
        paperless.upload_document(
            Settings(
                api_token="test-token",
                paperless_base_url="https://paperless.example.com",
                paperless_token="tok",
            ),
            filename="f.pdf",
            content_type="application/pdf",
            file_data=b"data",
            created=date(2026, 1, 1),
            title="T",
        )

    assert exc_info.value.code == "paperless_unreachable"


def test_upload_document_raises_on_non_string_task_id(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger.services.errors import UnavailableError

    class FakeResponse:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return 42

    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse())

    with pytest.raises(UnavailableError) as exc_info:
        paperless.upload_document(
            Settings(
                api_token="test-token",
                paperless_base_url="https://paperless.example.com",
                paperless_token="tok",
            ),
            filename="f.pdf",
            content_type="application/pdf",
            file_data=b"data",
            created=date(2026, 1, 1),
            title="T",
        )

    assert exc_info.value.code == "paperless_invalid_response"


def test_add_tags_raises_on_http_status_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger.services.errors import UnavailableError

    def fake_post(*args, **kwargs):
        response = httpx.Response(503)
        raise httpx.HTTPStatusError(
            "server error", request=httpx.Request("POST", "http://x"), response=response
        )

    monkeypatch.setattr(httpx, "post", fake_post)

    with pytest.raises(UnavailableError) as exc_info:
        paperless.add_tags_to_document(
            Settings(
                api_token="test-token",
                paperless_base_url="https://paperless.example.com",
                paperless_token="tok",
            ),
            84,
            [12],
        )

    assert exc_info.value.code == "paperless_tagging_failed"


def test_get_task_result_raises_on_http_status_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger.services.errors import UnavailableError

    def fake_get(*args, **kwargs):
        response = httpx.Response(503)
        raise httpx.HTTPStatusError(
            "error", request=httpx.Request("GET", "http://x"), response=response
        )

    monkeypatch.setattr(httpx, "get", fake_get)

    with pytest.raises(UnavailableError) as exc_info:
        paperless.get_task_result(
            Settings(
                api_token="test-token",
                paperless_base_url="https://paperless.example.com",
                paperless_token="tok",
            ),
            "task-abc",
        )

    assert exc_info.value.code == "paperless_task_poll_failed"


def test_get_task_result_returns_none_for_empty_list(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return []

    monkeypatch.setattr(httpx, "get", lambda *args, **kwargs: FakeResponse())

    result = paperless.get_task_result(
        Settings(
            api_token="test-token",
            paperless_base_url="https://paperless.example.com",
            paperless_token="tok",
        ),
        "task-empty",
    )

    assert result is None


def test_get_task_result_returns_none_for_dict_body_with_empty_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return {"results": []}

    monkeypatch.setattr(httpx, "get", lambda *args, **kwargs: FakeResponse())

    result = paperless.get_task_result(
        Settings(
            api_token="test-token",
            paperless_base_url="https://paperless.example.com",
            paperless_token="tok",
        ),
        "task-empty",
    )

    assert result is None


def test_get_task_result_raises_for_non_list_non_dict_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger.services.errors import UnavailableError

    class FakeResponse:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return "unexpected string"

    monkeypatch.setattr(httpx, "get", lambda *args, **kwargs: FakeResponse())

    with pytest.raises(UnavailableError) as exc_info:
        paperless.get_task_result(
            Settings(
                api_token="test-token",
                paperless_base_url="https://paperless.example.com",
                paperless_token="tok",
            ),
            "task-bad",
        )

    assert exc_info.value.code == "paperless_invalid_response"


def test_get_task_result_supports_dict_body_with_results_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return {
                "results": [
                    {
                        "task_id": "task-456",
                        "status": "success",
                        "result_data": {"document_id": 99},
                    }
                ]
            }

    monkeypatch.setattr(httpx, "get", lambda *args, **kwargs: FakeResponse())

    result = paperless.get_task_result(
        Settings(
            api_token="test-token",
            paperless_base_url="https://paperless.example.com",
            paperless_token="tok",
        ),
        "task-456",
    )

    assert result is not None
    assert result.status == "success"
    assert result.document_id == 99


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
            paperless_api_version=9,
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


# Real /api/tasks/ response from Paperless 3.2.1 at API v10 (trimmed)
PAPERLESS_3_V10_SUCCESS = {
    "count": 1,
    "next": None,
    "previous": None,
    "results": [
        {
            "id": 756,
            "task_id": "d15e5241-c09c-45ea-bff3-6e16d81917a7",
            "task_type": "consume_file",
            "trigger_source": "api_upload",
            "status": "success",
            "status_display": "Success",
            "input_data": {"filename": "Account Statement_2026-09-30.PDF"},
            "result_data": {"document_id": 2620},
            "related_document_ids": [2620],
            "acknowledged": False,
            "owner": 4,
        }
    ],
}

# Paperless 3.x serves API v9 through a compatibility serializer: `result` is rebuilt from
# result_data, `related_document` is an int (2.x sent a digit string) and duplicates come back
# as `duplicate_documents` objects instead of `duplicate_of`.
PAPERLESS_3_V9_SUCCESS = [
    {
        "id": 756,
        "task_id": "d15e5241-c09c-45ea-bff3-6e16d81917a7",
        "task_name": "consume_file",
        "task_file_name": "Account Statement_2026-09-30.PDF",
        "type": "manual_task",
        "status": "SUCCESS",
        "result": "Success. New document id 2620 created",
        "acknowledged": False,
        "related_document": 2620,
        "duplicate_documents": [],
        "owner": 4,
    }
]

PAPERLESS_3_V9_DUPLICATE = [
    {
        "id": 757,
        "task_id": "task-dup",
        "task_name": "consume_file",
        "task_file_name": "statement.pdf",
        "type": "manual_task",
        "status": "FAILURE",
        "result": "Not consuming: It is a duplicate of document #2578",
        "acknowledged": False,
        "related_document": None,
        "duplicate_documents": [{"id": 2578, "title": "Payslip", "deleted_at": None}],
        "owner": 4,
    }
]


@pytest.mark.parametrize(
    ("api_version", "body", "expected"),
    [
        (
            10,
            PAPERLESS_3_V10_SUCCESS,
            paperless.PaperlessTaskResult(status="success", document_id=2620, error_code="success"),
        ),
        (
            10,
            {"results": [{"status": "failure", "result_data": {"duplicate_of": 2578}}]},
            paperless.PaperlessTaskResult(
                status="failure", duplicate_of=2578, error_code="failure"
            ),
        ),
        (
            10,
            {"results": [{"status": "failure", "result_data": {"error_message": "OCR failed"}}]},
            paperless.PaperlessTaskResult(
                status="failure", error_code="failure", error_message="OCR failed"
            ),
        ),
        (
            9,
            PAPERLESS_3_V9_SUCCESS,
            paperless.PaperlessTaskResult(
                status="success",
                document_id=2620,
                error_code="success",
                error_message="Success. New document id 2620 created",
            ),
        ),
        (
            9,
            PAPERLESS_3_V9_DUPLICATE,
            paperless.PaperlessTaskResult(
                status="failure",
                duplicate_of=2578,
                error_code="failure",
                error_message="Not consuming: It is a duplicate of document #2578",
            ),
        ),
    ],
    ids=["v10-success", "v10-duplicate", "v10-error", "v9-on-3x-success", "v9-on-3x-duplicate"],
)
def test_get_task_result_parses_response_for_requested_api_version(
    monkeypatch: pytest.MonkeyPatch,
    api_version: int,
    body: object,
    expected: paperless.PaperlessTaskResult,
) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self):
            return body

    requests: list[dict[str, Any]] = []

    def fake_get(*args, **kwargs):
        requests.append(kwargs)
        return FakeResponse()

    monkeypatch.setattr(httpx, "get", fake_get)

    result = paperless.get_task_result(
        Settings(
            api_token="test-token",
            paperless_base_url="https://paperless.example.com",
            paperless_token="paperless-token",
            paperless_api_version=api_version,
        ),
        "task-123",
    )

    assert result == expected
    assert requests[0]["headers"]["Accept"] == f"application/json; version={api_version}"


# ---------------------------------------------------------------------------
# extract_document_id
# ---------------------------------------------------------------------------


def test_extract_document_id_web_ui_url() -> None:
    assert extract_document_id("http://paperless:8000/documents/2155") == 2155


def test_extract_document_id_web_ui_url_trailing_slash() -> None:
    assert extract_document_id("https://paperless.example.com/documents/42/") == 42


def test_extract_document_id_also_matches_legacy_api_url() -> None:
    assert extract_document_id("https://paperless.example.com/api/documents/42/") == 42


def test_extract_document_id_unrecognised_url() -> None:
    assert extract_document_id("https://example.com/other/path") is None
