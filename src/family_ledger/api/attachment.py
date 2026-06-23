from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile, status

from family_ledger.api._helpers import DbSession, _call_service
from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    AttachmentResource,
    CreateAttachmentRequest,
    ListAttachmentsResponse,
    UpdateAttachmentRequest,
)
from family_ledger.config import Settings, get_settings
from family_ledger.services import attachments as attachment_service

router = APIRouter(dependencies=[Depends(require_api_token)])

AppSettings = Annotated[Settings, Depends(get_settings)]


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
    status_code=status.HTTP_201_CREATED,
)
def create_attachment(
    session: DbSession,
    request: CreateAttachmentRequest,
) -> AttachmentResource:
    a = request.attachment
    return _call_service(
        attachment_service.create_attachment,
        session,
        account=a.account,
        attachment_date=a.attachment_date,
        original_filename=a.original_filename,
        media_type=a.media_type,
        document_url=a.document_url,
        entity_metadata=a.entity_metadata,
    )


@router.patch("/attachments/{attachment:path}", response_model=AttachmentResource)
def update_attachment(
    attachment: str,
    request: UpdateAttachmentRequest,
    session: DbSession,
) -> AttachmentResource:
    a = request.attachment
    return _call_service(
        attachment_service.update_attachment,
        session,
        attachment,
        account=a.account,
        attachment_date=a.attachment_date,
        original_filename=a.original_filename,
        media_type=a.media_type,
        document_url=a.document_url,
        entity_metadata=a.entity_metadata,
    )


@router.delete("/attachments/{attachment:path}", status_code=status.HTTP_204_NO_CONTENT)
def delete_attachment(attachment: str, session: DbSession) -> None:
    _call_service(attachment_service.delete_attachment, session, attachment)


@router.post(
    "/attachments/{attachment:path}:upload",
    response_model=AttachmentResource,
    status_code=status.HTTP_202_ACCEPTED,
)
def upload_attachment(
    attachment: str,
    session: DbSession,
    settings: AppSettings,
    file: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form()] = None,
) -> AttachmentResource:
    return _call_service(
        attachment_service.upload_attachment,
        session,
        settings,
        attachment_name=attachment,
        file_data=file.file.read(),
        media_type=file.content_type,
        title=title,
    )
