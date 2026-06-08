from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from family_ledger.api.schemas import AttachmentResource, ListAttachmentsResponse
from family_ledger.config import Settings
from family_ledger.models import Attachment
from family_ledger.services import paperless
from family_ledger.services.errors import NotFoundError
from family_ledger.services.identifiers import generate_resource_name
from family_ledger.services.ledger import (
    commit_or_raise,
    decode_page_token,
    encode_page_token,
    normalize_page_size,
    paginate_query,
)
from family_ledger.services.validation import resolve_account, resource_name


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _storage_metadata_timestamp(now: datetime) -> str:
    return now.isoformat(timespec="seconds") + "Z"


def serialize_attachment(attachment: Attachment) -> AttachmentResource:
    return AttachmentResource(
        name=attachment.name,
        account=attachment.account.name,
        attachment_date=attachment.attachment_date,
        original_filename=attachment.original_filename,
        media_type=attachment.media_type,
        status=attachment.status,
        document_url=attachment.document_url,
        entity_metadata=attachment.entity_metadata,
    )


def create_attachment(
    session: Session,
    *,
    account: str,
    attachment_date: date,
    original_filename: str,
    media_type: str | None,
    document_url: str | None,
    entity_metadata: dict[str, Any],
) -> AttachmentResource:
    account_row = resolve_account(session, account)
    status = Attachment.STATUS_STORED if document_url else Attachment.STATUS_PENDING_UPLOAD
    storage_metadata: dict[str, Any] = {}
    if document_url is not None:
        doc_id = paperless.extract_document_id(document_url)
        if doc_id is not None:
            storage_metadata["document_id"] = doc_id
    attachment = Attachment(
        name=generate_resource_name("attachments", "att"),
        account=account_row,
        attachment_date=attachment_date,
        original_filename=original_filename,
        media_type=media_type,
        status=status,
        document_url=document_url,
        storage_backend=paperless.BACKEND_NAME,
        storage_deadline_at=utcnow(),
        entity_metadata=entity_metadata,
        storage_metadata=storage_metadata,
    )
    session.add(attachment)
    commit_or_raise(session)
    attachment = session.scalar(
        select(Attachment)
        .options(selectinload(Attachment.account))
        .where(Attachment.id == attachment.id)
    )
    assert attachment is not None
    return serialize_attachment(attachment)


def upload_attachment(
    session: Session,
    settings: Settings,
    *,
    attachment_name: str,
    file_data: bytes,
    media_type: str | None,
    title: str | None = None,
) -> AttachmentResource:
    resolved_name = resource_name("attachments", attachment_name)
    attachment = session.scalar(
        select(Attachment)
        .options(selectinload(Attachment.account))
        .where(Attachment.name == resolved_name)
    )
    if attachment is None:
        raise NotFoundError(code="attachment_not_found", message="Attachment not found")
    task_id = paperless.upload_document(
        settings,
        filename=attachment.original_filename,
        content_type=media_type,
        file_data=file_data,
        created=attachment.attachment_date,
        title=title,
    )
    now = utcnow()
    attachment.status = Attachment.STATUS_PENDING_STORAGE
    attachment.document_url = None
    attachment.storage_deadline_at = now + timedelta(
        seconds=settings.paperless_ingestion_timeout_seconds
    )
    attachment.storage_metadata = {
        "task_id": task_id,
        "task_url": paperless.build_task_url(settings, task_id),
        "submitted_at": _storage_metadata_timestamp(now),
    }
    session.commit()
    session.refresh(attachment)
    return serialize_attachment(attachment)


def list_attachments_page(
    session: Session,
    *,
    page_size: int | None,
    page_token: str | None,
) -> ListAttachmentsResponse:
    normalized_page_size = normalize_page_size(page_size)
    offset = decode_page_token(page_token)
    attachments = session.scalars(
        paginate_query(
            select(Attachment)
            .options(selectinload(Attachment.account))
            .order_by(Attachment.attachment_date, Attachment.name),
            offset=offset,
            page_size=normalized_page_size,
        )
    ).all()
    next_page_token = None
    if len(attachments) > normalized_page_size:
        attachments = attachments[:normalized_page_size]
        next_page_token = encode_page_token(offset + normalized_page_size)
    return ListAttachmentsResponse(
        attachments=[serialize_attachment(attachment) for attachment in attachments],
        next_page_token=next_page_token,
    )


def update_attachment(
    session: Session,
    attachment: str,
    *,
    account: str,
    attachment_date: date,
    original_filename: str,
    media_type: str | None,
    document_url: str | None,
    entity_metadata: dict[str, Any],
) -> AttachmentResource:
    resolved_name = resource_name("attachments", attachment)
    attachment_row = session.scalar(
        select(Attachment)
        .options(selectinload(Attachment.account))
        .where(Attachment.name == resolved_name)
    )
    if attachment_row is None:
        raise NotFoundError(code="attachment_not_found", message="Attachment not found")
    account_row = resolve_account(session, account)
    attachment_row.account = account_row
    attachment_row.attachment_date = attachment_date
    attachment_row.original_filename = original_filename
    attachment_row.media_type = media_type
    attachment_row.document_url = document_url
    attachment_row.entity_metadata = entity_metadata
    if document_url is not None:
        attachment_row.status = Attachment.STATUS_STORED
        doc_id = paperless.extract_document_id(document_url)
        if doc_id is not None:
            attachment_row.storage_backend = paperless.BACKEND_NAME
            metadata = dict(attachment_row.storage_metadata or {})
            metadata["document_id"] = doc_id
            attachment_row.storage_metadata = metadata
    commit_or_raise(session)
    session.refresh(attachment_row)
    return serialize_attachment(attachment_row)


def delete_attachment(session: Session, attachment: str) -> None:
    resolved_name = resource_name("attachments", attachment)
    attachment_row = session.scalar(select(Attachment).where(Attachment.name == resolved_name))
    if attachment_row is None:
        raise NotFoundError(code="attachment_not_found", message="Attachment not found")
    session.delete(attachment_row)
    commit_or_raise(session)


def get_attachment_by_name(session: Session, attachment: str) -> AttachmentResource:
    resolved_name = resource_name("attachments", attachment)
    attachment_row = session.scalar(
        select(Attachment)
        .options(selectinload(Attachment.account))
        .where(Attachment.name == resolved_name)
    )
    if attachment_row is None:
        raise NotFoundError(code="attachment_not_found", message="Attachment not found")
    return serialize_attachment(attachment_row)


def _set_storage_failure(
    attachment: Attachment,
    *,
    status: str,
    error_code: str,
    error_message: str,
    now: datetime,
) -> None:
    metadata = dict(attachment.storage_metadata)
    metadata["last_checked_at"] = _storage_metadata_timestamp(now)
    metadata["last_error_code"] = error_code
    metadata["last_error_message"] = error_message
    attachment.storage_metadata = metadata
    attachment.status = status


def process_pending_attachments(
    session: Session,
    settings: Settings,
    *,
    now: datetime | None = None,
    batch_size: int = 20,
) -> int:
    current_time = now or utcnow()
    pending = session.scalars(
        select(Attachment)
        .where(Attachment.status == Attachment.STATUS_PENDING_STORAGE)
        .order_by(Attachment.storage_deadline_at, Attachment.name)
        .limit(batch_size)
    ).all()
    if not pending:
        return 0

    processed = 0
    for attachment in pending:
        processed += 1
        if current_time >= attachment.storage_deadline_at:
            _set_storage_failure(
                attachment,
                status=Attachment.STATUS_TIMED_OUT,
                error_code="timed_out",
                error_message="Attachment storage timed out",
                now=current_time,
            )
            continue

        task_id = attachment.storage_metadata.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            _set_storage_failure(
                attachment,
                status=Attachment.STATUS_FAILED,
                error_code="missing_task_id",
                error_message="Attachment storage metadata is missing a task identifier",
                now=current_time,
            )
            continue

        result = paperless.get_task_result(settings, task_id)
        metadata = dict(attachment.storage_metadata)
        metadata["last_checked_at"] = _storage_metadata_timestamp(current_time)
        if result is None or result.status not in paperless.TERMINAL_TASK_STATUSES:
            attachment.storage_metadata = metadata
            continue

        metadata["completed_at"] = _storage_metadata_timestamp(current_time)
        if result.document_id is not None:
            metadata["document_id"] = result.document_id
            attachment.document_url = paperless.build_document_url(settings, result.document_id)
            attachment.status = Attachment.STATUS_STORED
        elif result.duplicate_of is not None:
            paperless.add_tags_to_document(
                settings,
                result.duplicate_of,
                settings.paperless_tag_ids,
            )
            metadata["document_id"] = result.duplicate_of
            metadata["duplicate_of"] = result.duplicate_of
            attachment.document_url = paperless.build_document_url(settings, result.duplicate_of)
            attachment.status = Attachment.STATUS_STORED
        else:
            metadata["last_error_code"] = result.error_code
            metadata["last_error_message"] = result.error_message or "Attachment storage failed"
            attachment.status = Attachment.STATUS_FAILED
        attachment.storage_metadata = metadata

    session.commit()
    return processed
