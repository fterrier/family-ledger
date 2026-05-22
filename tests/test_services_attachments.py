from __future__ import annotations

from collections.abc import Generator
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy import select as sa_select
from sqlalchemy.orm import Session

from family_ledger.config import Settings
from family_ledger.models import Account, Attachment, Base
from family_ledger.models import Attachment as AttModel
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


def test_create_attachment_persists_pending_upload(
    session: Session,
) -> None:
    seed_account(session)

    created = attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        document_url=None,
        entity_metadata={"source": "bank"},
    )

    assert created.name.startswith("attachments/att_")
    assert created.account == "accounts/acc_one"
    assert created.status == attachments.ATTACHMENT_PENDING_UPLOAD_STATUS
    assert created.document_url is None
    assert created.entity_metadata == {"source": "bank"}

    persisted = session.get(Attachment, 1)
    assert persisted is not None
    assert persisted.storage_backend == "paperless"
    assert persisted.storage_metadata == {}


def test_create_attachment_with_url_persists_stored(
    session: Session,
) -> None:
    seed_account(session)

    created = attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        document_url="https://paperless.example.com/api/documents/42/",
        entity_metadata={},
    )

    assert created.status == attachments.ATTACHMENT_STORED_STATUS
    assert created.document_url == "https://paperless.example.com/api/documents/42/"


def test_upload_attachment_transitions_to_pending_storage(
    monkeypatch: pytest.MonkeyPatch,
    session: Session,
) -> None:
    seed_account(session)
    monkeypatch.setattr(paperless, "upload_document", lambda *args, **kwargs: "task-123")

    att = attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        document_url=None,
        entity_metadata={},
    )
    assert att.status == attachments.ATTACHMENT_PENDING_UPLOAD_STATUS

    uploaded = attachments.upload_attachment(
        session,
        make_settings(),
        attachment_name=att.name,
        file_data=b"pdf-data",
        media_type="application/pdf",
        title="May statement",
    )

    assert uploaded.status == attachments.ATTACHMENT_PENDING_STATUS
    assert uploaded.document_url is None
    persisted = session.get(Attachment, 1)
    assert persisted is not None
    assert persisted.storage_metadata["task_id"] == "task-123"
    assert persisted.storage_metadata["task_url"].endswith("task_id=task-123")


def test_upload_attachment_allowed_from_any_status(
    monkeypatch: pytest.MonkeyPatch,
    session: Session,
) -> None:
    account = seed_account(session)
    monkeypatch.setattr(paperless, "upload_document", lambda *args, **kwargs: "new-task")

    for initial_status in ("stored", "failed", "timed_out", "pending_storage"):
        existing = Attachment(
            name=f"attachments/att_{initial_status}",
            account=account,
            attachment_date=date(2026, 5, 19),
            original_filename=f"{initial_status}.pdf",
            media_type="application/pdf",
            status=initial_status,
            document_url=(
                "https://paperless.example.com/api/documents/1/"
                if initial_status == "stored"
                else None
            ),
            storage_backend="paperless",
            storage_deadline_at=datetime(2026, 5, 19, 12, 0, 0),
            entity_metadata={},
            storage_metadata={},
        )
        session.add(existing)
        session.commit()

        result = attachments.upload_attachment(
            session,
            make_settings(),
            attachment_name=existing.name,
            file_data=b"data",
            media_type="application/pdf",
        )

        assert result.status == attachments.ATTACHMENT_PENDING_STATUS
        session.delete(existing)
        session.commit()


def test_create_attachment_requires_existing_account(session: Session) -> None:
    with pytest.raises(ValidationError) as excinfo:
        attachments.create_attachment(
            session,
            account="accounts/missing",
            attachment_date=date(2026, 5, 19),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
        )

    assert excinfo.value.code == "account_not_found"


def test_upload_attachment_does_not_change_status_when_paperless_fails(
    monkeypatch: pytest.MonkeyPatch, session: Session
) -> None:
    seed_account(session)

    att = attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        document_url=None,
        entity_metadata={},
    )

    def raise_upload(*args, **kwargs):
        raise UnavailableError(code="paperless_unreachable", message="Paperless is unreachable")

    monkeypatch.setattr(paperless, "upload_document", raise_upload)

    with pytest.raises(UnavailableError):
        attachments.upload_attachment(
            session,
            make_settings(),
            attachment_name=att.name,
            file_data=b"pdf-data",
            media_type="application/pdf",
        )

    session.expire_all()
    persisted = session.get(Attachment, 1)
    assert persisted is not None
    assert persisted.status == attachments.ATTACHMENT_PENDING_UPLOAD_STATUS


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


def test_create_attachment_raises_conflict_on_duplicate(session: Session) -> None:
    seed_account(session)

    def _create() -> None:
        attachments.create_attachment(
            session,
            account="accounts/acc_one",
            attachment_date=date(2026, 5, 19),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
        )

    _create()

    from family_ledger.services.errors import ConflictError as CE

    with pytest.raises(CE):
        _create()


def test_build_attachment_doctor_issues_reports_all_actionable_statuses(
    session: Session,
) -> None:
    account = seed_account(session)
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    def _make(name: str, filename: str, att_date: date, att_status: str) -> Attachment:
        return Attachment(
            name=f"attachments/{name}",
            account=account,
            attachment_date=att_date,
            original_filename=filename,
            media_type="application/pdf",
            status=att_status,
            document_url=None,
            storage_backend="paperless",
            storage_deadline_at=now,
            entity_metadata={},
            storage_metadata={},
        )

    session.add_all(
        [
            _make(
                "att_pending_upload",
                "pending.pdf",
                date(2026, 5, 17),
                attachments.ATTACHMENT_PENDING_UPLOAD_STATUS,
            ),
            _make(
                "att_failed", "failed.pdf", date(2026, 5, 18), attachments.ATTACHMENT_FAILED_STATUS
            ),
            _make(
                "att_timed_out",
                "timeout.pdf",
                date(2026, 5, 19),
                attachments.ATTACHMENT_TIMED_OUT_STATUS,
            ),
        ]
    )
    session.commit()

    issues = attachments.build_attachment_doctor_issues(session)

    assert [(issue.target, issue.code) for issue in issues] == [
        ("attachments/att_pending_upload", "attachment_pending_upload"),
        ("attachments/att_failed", "attachment_storage_failed"),
        ("attachments/att_timed_out", "attachment_storage_timed_out"),
    ]


def test_update_attachment_changes_fields(session: Session) -> None:
    seed_account(session)
    account2 = Account(
        name="accounts/acc_two",
        account_name="Assets:Bank:Savings",
        effective_start_date=date(2020, 1, 1),
    )
    session.add(account2)
    session.commit()

    att = attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="old.pdf",
        media_type="application/pdf",
        document_url=None,
        entity_metadata={},
    )

    updated = attachments.update_attachment(
        session,
        att.name,
        account="accounts/acc_two",
        attachment_date=date(2026, 6, 1),
        original_filename="new.pdf",
        media_type="text/plain",
        document_url=None,
        entity_metadata={"source": "corrected"},
    )

    assert updated.account == "accounts/acc_two"
    assert updated.attachment_date == date(2026, 6, 1)
    assert updated.original_filename == "new.pdf"
    assert updated.media_type == "text/plain"
    assert updated.entity_metadata == {"source": "corrected"}
    assert updated.status == attachments.ATTACHMENT_PENDING_UPLOAD_STATUS


def test_update_attachment_with_document_url_sets_stored_status(session: Session) -> None:
    seed_account(session)

    att = attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        document_url=None,
        entity_metadata={},
    )
    assert att.status == attachments.ATTACHMENT_PENDING_UPLOAD_STATUS

    updated = attachments.update_attachment(
        session,
        att.name,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        document_url="https://paperless.example.com/api/documents/42/",
        entity_metadata={},
    )

    assert updated.status == attachments.ATTACHMENT_STORED_STATUS
    assert updated.document_url == "https://paperless.example.com/api/documents/42/"


def test_update_attachment_raises_not_found(session: Session) -> None:
    from family_ledger.services.errors import NotFoundError

    seed_account(session)
    with pytest.raises(NotFoundError):
        attachments.update_attachment(
            session,
            "attachments/att_missing",
            account="accounts/acc_one",
            attachment_date=date(2026, 5, 19),
            original_filename="x.pdf",
            media_type=None,
            document_url=None,
            entity_metadata={},
        )


def test_update_attachment_raises_conflict_on_duplicate_key(session: Session) -> None:
    from family_ledger.services.errors import ConflictError

    seed_account(session)

    attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="a.pdf",
        media_type=None,
        document_url=None,
        entity_metadata={},
    )
    att_b = attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="b.pdf",
        media_type=None,
        document_url=None,
        entity_metadata={},
    )

    with pytest.raises(ConflictError):
        attachments.update_attachment(
            session,
            att_b.name,
            account="accounts/acc_one",
            attachment_date=date(2026, 5, 19),
            original_filename="a.pdf",
            media_type=None,
            document_url=None,
            entity_metadata={},
        )


def test_delete_attachment_removes_record(session: Session) -> None:
    seed_account(session)

    att = attachments.create_attachment(
        session,
        account="accounts/acc_one",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
        media_type="application/pdf",
        document_url=None,
        entity_metadata={},
    )

    attachments.delete_attachment(session, att.name)

    assert session.scalar(sa_select(AttModel).where(AttModel.name == att.name)) is None


def test_delete_attachment_raises_not_found(session: Session) -> None:
    from family_ledger.services.errors import NotFoundError

    seed_account(session)
    with pytest.raises(NotFoundError):
        attachments.delete_attachment(session, "attachments/att_missing")
