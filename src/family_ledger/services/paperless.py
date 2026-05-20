from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from urllib.parse import urlencode

import httpx

from family_ledger.config import Settings
from family_ledger.services.errors import UnavailableError

REQUEST_TIMEOUT_SECONDS = 30.0
TERMINAL_TASK_STATUSES = {"success", "failure", "revoked"}


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
    return f"{base_url}/api/documents/{document_id}/"


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
    files = {
        "document": (
            filename,
            file_data,
            content_type or "application/octet-stream",
        )
    }
    data = {"created": created.isoformat()}
    if title is not None:
        data["title"] = title

    try:
        response = httpx.post(
            f"{base_url}/api/documents/post_document/",
            headers=_build_headers(settings),
            data=data,
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

    if not isinstance(body, dict):
        raise UnavailableError(
            code="paperless_invalid_response",
            message="Paperless returned an invalid task response",
        )

    results = body.get("results")
    if not isinstance(results, list) or not results:
        return None

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

    result_data = task.get("result_data")
    if not isinstance(result_data, dict):
        result_data = {}

    document_id = result_data.get("document_id")
    duplicate_of = result_data.get("duplicate_of")
    error_message = result_data.get("reason")
    if not isinstance(error_message, str):
        error_message = None

    return PaperlessTaskResult(
        status=status,
        document_id=document_id if isinstance(document_id, int) else None,
        duplicate_of=duplicate_of if isinstance(duplicate_of, int) else None,
        error_code=status if status in TERMINAL_TASK_STATUSES else None,
        error_message=error_message,
    )
