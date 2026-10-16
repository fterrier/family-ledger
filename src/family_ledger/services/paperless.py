from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any
from urllib.parse import urlencode

import httpx

from family_ledger.config import Settings
from family_ledger.services.errors import UnavailableError

REQUEST_TIMEOUT_SECONDS = 30.0
TERMINAL_TASK_STATUSES = {"success", "failure", "revoked"}
LEGACY_TERMINAL_TASK_STATUSES = {"SUCCESS", "FAILURE", "REVOKED"}

BACKEND_NAME = "paperless"
_DOCUMENT_ID_RE = re.compile(r"/documents/(\d+)")


def extract_document_id(document_url: str) -> int | None:
    match = _DOCUMENT_ID_RE.search(document_url)
    return int(match.group(1)) if match else None


@dataclass(frozen=True)
class PaperlessTaskResult:
    status: str
    document_id: int | None = None
    duplicate_of: int | None = None
    error_code: str | None = None
    error_message: str | None = None


def _require_paperless_settings(settings: Settings) -> tuple[str, str]:
    if not settings.paperless_is_configured():
        raise UnavailableError(
            code="paperless_not_configured",
            message="Paperless integration is not configured",
        )
    assert settings.paperless_base_url is not None
    assert settings.paperless_token is not None
    return settings.paperless_base_url.rstrip("/"), settings.paperless_token


def _build_headers(settings: Settings) -> dict[str, str]:
    _base_url, token = _require_paperless_settings(settings)
    return {
        "Authorization": f"Token {token}",
        "Accept": f"application/json; version={settings.paperless_api_version}",
    }


def build_task_url(settings: Settings, task_id: str) -> str:
    base_url, _token = _require_paperless_settings(settings)
    return f"{base_url}/api/tasks/?{urlencode({'task_id': task_id})}"


def build_document_url(settings: Settings, document_id: int) -> str:
    base_url, _token = _require_paperless_settings(settings)
    external_url = (settings.paperless_external_base_url or base_url).rstrip("/")
    return f"{external_url}/documents/{document_id}"


def upload_document(
    settings: Settings,
    *,
    filename: str,
    content_type: str | None,
    file_data: bytes,
    created: date,
    title: str | None,
) -> str:
    base_url, _token = _require_paperless_settings(settings)
    files: list[tuple[str, tuple[str | None, bytes | str, str | None] | tuple[None, str]]] = [
        (
            "document",
            (
                filename,
                file_data,
                content_type or "application/octet-stream",
            ),
        ),
        ("created", (None, created.isoformat())),
    ]
    if title is not None:
        files.append(("title", (None, title)))
    for tag_id in settings.paperless_tag_ids:
        files.append(("tags", (None, str(tag_id))))

    try:
        response = httpx.post(
            f"{base_url}/api/documents/post_document/",
            headers=_build_headers(settings),
            files=files,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        task_id = response.json()
    except httpx.HTTPStatusError as exc:
        raise UnavailableError(
            code="paperless_upload_failed",
            message=f"Paperless upload failed with status {exc.response.status_code}",
        ) from exc
    except httpx.HTTPError as exc:
        raise UnavailableError(
            code="paperless_unreachable",
            message="Paperless is unreachable",
        ) from exc
    if not isinstance(task_id, str) or not task_id:
        raise UnavailableError(
            code="paperless_invalid_response",
            message="Paperless returned an invalid task identifier",
        )
    return task_id


def add_tags_to_document(settings: Settings, document_id: int, tag_ids: list[int]) -> None:
    if not tag_ids:
        return

    base_url, _token = _require_paperless_settings(settings)
    try:
        for tag_id in tag_ids:
            response = httpx.post(
                f"{base_url}/api/documents/bulk_edit/",
                headers=_build_headers(settings),
                json={
                    "documents": [document_id],
                    "method": "add_tag",
                    "parameters": {"tag": tag_id},
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise UnavailableError(
            code="paperless_tagging_failed",
            message=f"Paperless document tagging failed with status {exc.response.status_code}",
        ) from exc
    except httpx.HTTPError as exc:
        raise UnavailableError(
            code="paperless_unreachable",
            message="Paperless is unreachable",
        ) from exc


def download_document(settings: Settings, document_id: int) -> bytes:
    base_url, _token = _require_paperless_settings(settings)
    download_url = f"{base_url}/api/documents/{document_id}/download/"
    try:
        response = httpx.get(
            download_url,
            headers=_build_headers(settings),
            timeout=REQUEST_TIMEOUT_SECONDS,
            follow_redirects=True,
        )
        response.raise_for_status()
        return response.content
    except httpx.HTTPStatusError as exc:
        raise UnavailableError(
            code="paperless_download_failed",
            message=f"Paperless download failed with status {exc.response.status_code}",
        ) from exc
    except httpx.HTTPError as exc:
        raise UnavailableError(
            code="paperless_unreachable",
            message="Paperless is unreachable",
        ) from exc


def get_task_result(settings: Settings, task_id: str) -> PaperlessTaskResult | None:
    base_url, _token = _require_paperless_settings(settings)
    try:
        response = httpx.get(
            f"{base_url}/api/tasks/",
            headers=_build_headers(settings),
            params={"task_id": task_id},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        body = response.json()
    except httpx.HTTPStatusError as exc:
        raise UnavailableError(
            code="paperless_task_poll_failed",
            message=f"Paperless task polling failed with status {exc.response.status_code}",
        ) from exc
    except httpx.HTTPError as exc:
        raise UnavailableError(
            code="paperless_unreachable",
            message="Paperless is unreachable",
        ) from exc

    if isinstance(body, dict):
        results = body.get("results")
        if not isinstance(results, list) or not results:
            return None
    elif isinstance(body, list):
        results = body
        if not results:
            return None
    else:
        raise UnavailableError(
            code="paperless_invalid_response",
            message="Paperless returned an invalid task response",
        )

    task = results[0]
    if not isinstance(task, dict):
        raise UnavailableError(
            code="paperless_invalid_response",
            message="Paperless returned an invalid task response",
        )

    status = task.get("status")
    if not isinstance(status, str):
        raise UnavailableError(
            code="paperless_invalid_response",
            message="Paperless task response omitted status",
        )

    if settings.paperless_api_version >= 10:
        document_id, duplicate_of, error_message = _parse_task_v10(task)
    else:
        document_id, duplicate_of, error_message = _parse_task_v9(task)

    normalized_status = status.lower() if status in LEGACY_TERMINAL_TASK_STATUSES else status

    return PaperlessTaskResult(
        status=normalized_status,
        document_id=document_id,
        duplicate_of=duplicate_of,
        error_code=normalized_status if normalized_status in TERMINAL_TASK_STATUSES else None,
        error_message=error_message,
    )


def _as_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _parse_task_v10(task: dict[str, Any]) -> tuple[int | None, int | None, str | None]:
    """API v10 (Paperless 3.x): outcome lives in `result_data`."""
    result_data = task.get("result_data")
    if not isinstance(result_data, dict):
        result_data = {}
    document_id = _as_int(result_data.get("document_id"))
    if document_id is None:
        related = task.get("related_document_ids")
        if isinstance(related, list) and related:
            document_id = _as_int(related[0])
    error_message = result_data.get("error_message") or result_data.get("reason")
    return (
        document_id,
        _as_int(result_data.get("duplicate_of")),
        error_message if isinstance(error_message, str) else None,
    )


def _parse_task_v9(task: dict[str, Any]) -> tuple[int | None, int | None, str | None]:
    """API v9: `related_document` is a digit string on Paperless 2.x and an int on 3.x;
    Paperless 3.x reports duplicates only via `duplicate_documents`."""
    duplicate_of = None
    duplicates = task.get("duplicate_documents")
    if isinstance(duplicates, list) and duplicates and isinstance(duplicates[0], dict):
        duplicate_of = _as_int(duplicates[0].get("id"))
    result = task.get("result")
    return (
        _as_int(task.get("related_document")),
        duplicate_of,
        result if isinstance(result, str) else None,
    )
