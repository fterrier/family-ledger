from __future__ import annotations

from collections.abc import Generator
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.config import Settings
from family_ledger.models import Account, Attachment, Base
from family_ledger.services import attachments, paperless
from family_ledger.services.errors import UnavailableError, ValidationError


@pytest.fixture
def session() -> Generator[Session, None, None]:
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)

    with Session(engine) as session:
        yield session


def make_settings() -> Settings:
    return Settings(
        api_token="test-token",
        paperless_base_url="https://paperless.example.com",
        paperless_token="paperless-token",
        attachment_poller_enabled=False,
    )


def seed_account(session: Session) -> Account:
    account = Account(
        name="accounts/acc_one",
        account_name="Assets:Bank:Checking",
        effective_start_date=date(2020, 1, 1),
    )
    session.add(account)
    session.commit()
    return account


def test_create_attachment_persists_pending_storage(
    monkeypatch: pytest.MonkeyPatch,
    session: Session,
) -> None:
    seed_account(session)
    settings = make_settings()
    monkeypatch.setattr(
        paperless,
        "upload_document",
        lambda *args, **kwargs: "task-123",
    )

    created = attachments.create_attachment(
        session,
        settings,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        file_data=b"pdf-data",
        title="May statement",
        entity_metadata={"source": "bank"},
    )

    assert created.name.startswith("attachments/att_")
    assert created.account == "accounts/acc_one"
    assert created.status == attachments.ATTACHMENT_PENDING_STATUS
    assert created.document_url is None
    assert created.entity_metadata == {"source": "bank"}

    persisted = session.get(Attachment, 1)
    assert persisted is not None
    assert persisted.storage_backend == "paperless"
    assert persisted.storage_metadata["task_id"] == "task-123"
    assert persisted.storage_metadata["task_url"].endswith("task_id=task-123")


def test_create_attachment_requires_existing_account(session: Session) -> None:
    with pytest.raises(ValidationError) as excinfo:
        attachments.create_attachment(
            session,
            make_settings(),
            account="accounts/missing",
            attachment_date=date(2026, 5, 19),
            original_filename="statement.pdf",
            media_type="application/pdf",
            file_data=b"pdf-data",
            title=None,
            entity_metadata={},
        )

    assert excinfo.value.code == "account_not_found"


def test_create_attachment_does_not_persist_when_upload_fails(
    monkeypatch: pytest.MonkeyPatch, session: Session
) -> None:
    seed_account(session)

    def raise_upload(*args, **kwargs):
        raise UnavailableError(code="paperless_unreachable", message="Paperless is unreachable")

    monkeypatch.setattr(paperless, "upload_document", raise_upload)

    with pytest.raises(UnavailableError):
        attachments.create_attachment(
            session,
            make_settings(),
            account="accounts/acc_one",
            attachment_date=date(2026, 5, 19),
            original_filename="statement.pdf",
            media_type="application/pdf",
            file_data=b"pdf-data",
            title=None,
            entity_metadata={},
        )

    assert session.query(Attachment).count() == 0


def test_process_pending_attachment_marks_stored_from_document_id(
    monkeypatch: pytest.MonkeyPatch, session: Session
) -> None:
    account = seed_account(session)
    attachment = Attachment(
        name="attachments/att_one",
        account=account,
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        status=attachments.ATTACHMENT_PENDING_STATUS,
        document_url=None,
        storage_backend="paperless",
        storage_deadline_at=datetime(2026, 5, 19, 12, 30, 0),
        entity_metadata={},
        storage_metadata={"task_id": "task-123"},
    )
    session.add(attachment)
    session.commit()

    monkeypatch.setattr(
        paperless,
        "get_task_result",
        lambda settings, task_id: paperless.PaperlessTaskResult(status="success", document_id=42),
    )

    processed = attachments.process_pending_attachments(
        session,
        make_settings(),
        now=datetime(2026, 5, 19, 12, 0, 0),
    )

    assert processed == 1
    session.refresh(attachment)
    assert attachment.status == attachments.ATTACHMENT_STORED_STATUS
    assert attachment.document_url == "https://paperless.example.com/api/documents/42/"
    assert attachment.storage_metadata["document_id"] == 42


def test_process_pending_attachment_marks_stored_from_duplicate_of(
    monkeypatch: pytest.MonkeyPatch, session: Session
) -> None:
    account = seed_account(session)
    attachment = Attachment(
        name="attachments/att_one",
        account=account,
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        status=attachments.ATTACHMENT_PENDING_STATUS,
        document_url=None,
        storage_backend="paperless",
        storage_deadline_at=datetime(2026, 5, 19, 12, 30, 0),
        entity_metadata={},
        storage_metadata={"task_id": "task-123"},
    )
    session.add(attachment)
    session.commit()

    settings = make_settings().model_copy(update={"paperless_tag_ids": [12]})
    monkeypatch.setattr(
        paperless,
        "get_task_result",
        lambda settings, task_id: paperless.PaperlessTaskResult(status="success", duplicate_of=84),
    )
    captured: list[tuple[int, list[int]]] = []
    monkeypatch.setattr(
        paperless,
        "add_tags_to_document",
        lambda settings, document_id, tag_ids: captured.append((document_id, list(tag_ids))),
    )

    attachments.process_pending_attachments(
        session,
        settings,
        now=datetime(2026, 5, 19, 12, 0, 0),
    )

    session.refresh(attachment)
    assert attachment.status == attachments.ATTACHMENT_STORED_STATUS
    assert attachment.document_url == "https://paperless.example.com/api/documents/84/"
    assert attachment.storage_metadata["duplicate_of"] == 84
    assert captured == [(84, [12])]


def test_process_pending_attachment_marks_failed_when_duplicate_tagging_fails(
    monkeypatch: pytest.MonkeyPatch, session: Session
) -> None:
    account = seed_account(session)
    attachment = Attachment(
        name="attachments/att_one",
        account=account,
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        status=attachments.ATTACHMENT_PENDING_STATUS,
        document_url=None,
        storage_backend="paperless",
        storage_deadline_at=datetime(2026, 5, 19, 12, 30, 0),
        entity_metadata={},
        storage_metadata={"task_id": "task-123"},
    )
    session.add(attachment)
    session.commit()

    settings = make_settings().model_copy(update={"paperless_tag_ids": [12]})
    monkeypatch.setattr(
        paperless,
        "get_task_result",
        lambda settings, task_id: paperless.PaperlessTaskResult(status="success", duplicate_of=84),
    )

    def raise_tagging(*args, **kwargs):
        raise UnavailableError(code="paperless_tagging_failed", message="Tagging failed")

    monkeypatch.setattr(paperless, "add_tags_to_document", raise_tagging)

    with pytest.raises(UnavailableError):
        attachments.process_pending_attachments(
            session,
            settings,
            now=datetime(2026, 5, 19, 12, 0, 0),
        )

    session.refresh(attachment)
    assert attachment.status == attachments.ATTACHMENT_PENDING_STATUS


def test_process_pending_attachment_marks_failed_on_terminal_error(
    monkeypatch: pytest.MonkeyPatch, session: Session
) -> None:
    account = seed_account(session)
    attachment = Attachment(
        name="attachments/att_one",
        account=account,
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        status=attachments.ATTACHMENT_PENDING_STATUS,
        document_url=None,
        storage_backend="paperless",
        storage_deadline_at=datetime(2026, 5, 19, 12, 30, 0),
        entity_metadata={},
        storage_metadata={"task_id": "task-123"},
    )
    session.add(attachment)
    session.commit()

    monkeypatch.setattr(
        paperless,
        "get_task_result",
        lambda settings, task_id: paperless.PaperlessTaskResult(
            status="failure",
            error_code="failure",
            error_message="OCR failed",
        ),
    )

    attachments.process_pending_attachments(
        session,
        make_settings(),
        now=datetime(2026, 5, 19, 12, 0, 0),
    )

    session.refresh(attachment)
    assert attachment.status == attachments.ATTACHMENT_FAILED_STATUS
    assert attachment.storage_metadata["last_error_code"] == "failure"
    assert attachment.storage_metadata["last_error_message"] == "OCR failed"


def test_process_pending_attachment_marks_timed_out(session: Session) -> None:
    account = seed_account(session)
    attachment = Attachment(
        name="attachments/att_one",
        account=account,
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        status=attachments.ATTACHMENT_PENDING_STATUS,
        document_url=None,
        storage_backend="paperless",
        storage_deadline_at=datetime(2026, 5, 19, 11, 59, 59),
        entity_metadata={},
        storage_metadata={"task_id": "task-123"},
    )
    session.add(attachment)
    session.commit()

    attachments.process_pending_attachments(
        session,
        make_settings(),
        now=datetime(2026, 5, 19, 12, 0, 0),
    )

    session.refresh(attachment)
    assert attachment.status == attachments.ATTACHMENT_TIMED_OUT_STATUS
    assert attachment.storage_metadata["last_error_code"] == "timed_out"


@pytest.mark.parametrize("existing_status", ["pending_storage", "stored"])
def test_create_attachment_dedup_returns_existing_when_nonterminal(
    monkeypatch: pytest.MonkeyPatch,
    session: Session,
    existing_status: str,
) -> None:
    account = seed_account(session)
    existing = Attachment(
        name="attachments/att_existing",
        account=account,
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        status=existing_status,
        document_url="https://paperless.example.com/api/documents/7/"
        if existing_status == "stored"
        else None,
        storage_backend="paperless",
        storage_deadline_at=datetime(2026, 5, 19, 12, 30, 0),
        entity_metadata={},
        storage_metadata={"task_id": "old-task"},
    )
    session.add(existing)
    session.commit()

    upload_calls: list[str] = []
    monkeypatch.setattr(
        paperless, "upload_document", lambda *a, **kw: upload_calls.append("called") or "new-task"
    )

    result = attachments.create_attachment(
        session,
        make_settings(),
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        file_data=b"pdf-data",
        title=None,
        entity_metadata={},
    )

    assert upload_calls == [], (
        "upload_document should not be called for existing non-terminal attachment"
    )
    assert result.name == "attachments/att_existing"
    assert result.status == existing_status
    assert session.query(Attachment).count() == 1


@pytest.mark.parametrize("existing_status", ["timed_out", "failed"])
def test_create_attachment_dedup_resubmits_when_terminal(
    monkeypatch: pytest.MonkeyPatch,
    session: Session,
    existing_status: str,
) -> None:
    account = seed_account(session)
    existing = Attachment(
        name="attachments/att_existing",
        account=account,
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        status=existing_status,
        document_url=None,
        storage_backend="paperless",
        storage_deadline_at=datetime(2026, 5, 19, 10, 0, 0),
        entity_metadata={},
        storage_metadata={"task_id": "old-task", "last_error_code": existing_status},
    )
    session.add(existing)
    session.commit()

    monkeypatch.setattr(paperless, "upload_document", lambda *a, **kw: "new-task")

    result = attachments.create_attachment(
        session,
        make_settings(),
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        file_data=b"pdf-data",
        title=None,
        entity_metadata={},
    )

    assert result.name == "attachments/att_existing", (
        "should reuse the existing record, not create a new one"
    )
    assert result.status == attachments.ATTACHMENT_PENDING_STATUS
    assert session.query(Attachment).count() == 1
    session.refresh(existing)
    assert existing.status == attachments.ATTACHMENT_PENDING_STATUS
    assert existing.storage_metadata["task_id"] == "new-task"
    assert "last_error_code" not in existing.storage_metadata
    assert existing.storage_deadline_at > datetime(2026, 5, 19, 10, 0, 0)


def test_build_attachment_doctor_issues_reports_failed_and_timed_out(session: Session) -> None:
    account = seed_account(session)
    failed = Attachment(
        name="attachments/att_failed",
        account=account,
        attachment_date=date(2026, 5, 18),
        original_filename="failed.pdf",
        media_type="application/pdf",
        status=attachments.ATTACHMENT_FAILED_STATUS,
        document_url=None,
        storage_backend="paperless",
        storage_deadline_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=5),
        entity_metadata={},
        storage_metadata={},
    )
    timed_out = Attachment(
        name="attachments/att_timed_out",
        account=account,
        attachment_date=date(2026, 5, 19),
        original_filename="timeout.pdf",
        media_type="application/pdf",
        status=attachments.ATTACHMENT_TIMED_OUT_STATUS,
        document_url=None,
        storage_backend="paperless",
        storage_deadline_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5),
        entity_metadata={},
        storage_metadata={},
    )
    session.add_all([timed_out, failed])
    session.commit()

    issues = attachments.build_attachment_doctor_issues(session)

    assert [(issue.target, issue.code) for issue in issues] == [
        ("attachments/att_failed", "attachment_storage_failed"),
        ("attachments/att_timed_out", "attachment_storage_timed_out"),
    ]
