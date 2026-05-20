from __future__ import annotations

import json
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import AttachmentResource, ListAttachmentsResponse
from family_ledger.config import Settings, get_settings
from family_ledger.db import get_db_session
from family_ledger.services import attachments as attachment_service
from family_ledger.services.errors import (
    ConflictError,
    NotFoundError,
    ServiceError,
    UnavailableError,
    ValidationError,
)

router = APIRouter(dependencies=[Depends(require_api_token)])

DbSession = Annotated[Session, Depends(get_db_session)]
AppSettings = Annotated[Settings, Depends(get_settings)]


def _translate_service_error(error: ServiceError) -> HTTPException:
    if isinstance(error, ValidationError):
        status_code = status.HTTP_400_BAD_REQUEST
    elif isinstance(error, NotFoundError):
        status_code = status.HTTP_404_NOT_FOUND
    elif isinstance(error, ConflictError):
        status_code = status.HTTP_409_CONFLICT
    elif isinstance(error, UnavailableError):
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    else:
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    return HTTPException(
        status_code=status_code,
        detail={"code": error.code, "message": error.message},
    )


def _call_service(fn, *args, **kwargs):  # type: ignore[no-untyped-def]
    try:
        return fn(*args, **kwargs)
    except ServiceError as error:
        raise _translate_service_error(error) from error


def _parse_entity_metadata(raw: str | None) -> dict[str, Any]:
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_entity_metadata",
                "message": "entity_metadata is not valid JSON",
            },
        ) from exc
    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_entity_metadata",
                "message": "entity_metadata must be a JSON object",
            },
        )
    return parsed


@router.get("/attachments", response_model=ListAttachmentsResponse)
def list_attachments(
    session: DbSession,
    page_size: int | None = None,
    page_token: str | None = None,
) -> ListAttachmentsResponse:
    return _call_service(
        attachment_service.list_attachments_page,
        session,
        page_size=page_size,
        page_token=page_token,
    )


@router.get("/attachments/{attachment:path}", response_model=AttachmentResource)
def get_attachment(attachment: str, session: DbSession) -> AttachmentResource:
    return _call_service(attachment_service.get_attachment_by_name, session, attachment)


@router.post(
    "/attachments",
    response_model=AttachmentResource,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_attachment(
    session: DbSession,
    settings: AppSettings,
    file: Annotated[UploadFile, File()],
    account: Annotated[str, Form()],
    attachment_date: Annotated[date, Form()],
    title: Annotated[str | None, Form()] = None,
    entity_metadata: Annotated[str | None, Form()] = None,
) -> AttachmentResource:
    metadata = _parse_entity_metadata(entity_metadata)
    file_data = file.file.read()
    return _call_service(
        attachment_service.create_attachment,
        session,
        settings,
        account=account,
        attachment_date=attachment_date,
        original_filename=file.filename or "attachment",
        media_type=file.content_type,
        file_data=file_data,
        title=title,
        entity_metadata=metadata,
    )
