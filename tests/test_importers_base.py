from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import MoneyValue, PadEntry, PadResponse
from family_ledger.config import Settings
from family_ledger.importers.base import ImportContext
from family_ledger.models import Account, Attachment, Base, Commodity


@pytest.fixture
def session() -> Generator[Session, None, None]:
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(Commodity(name="commodities/CHF", symbol="CHF", entity_metadata={}))
        s.add(
            Account(
                name="accounts/checking",
                account_name="Assets:Bank:Checking",
                effective_start_date=date(2020, 1, 1),
                entity_metadata={},
            )
        )
        s.add(
            Account(
                name="accounts/savings",
                account_name="Assets:Bank:Savings",
                effective_start_date=date(2020, 1, 1),
                entity_metadata={},
            )
        )
        s.commit()
        yield s


def _make_settings() -> Settings:
    return Settings(
        api_token="test-token",
        paperless_base_url="https://paperless.example.com",
        paperless_token="paperless-token",
        attachment_poller_enabled=False,
    )


# ---------------------------------------------------------------------------
# load_account_names
# ---------------------------------------------------------------------------


def test_load_account_names_returns_all_resource_names(session: Session) -> None:
    ctx = ImportContext(session)
    names = ctx.load_account_names()
    assert names == {"accounts/checking", "accounts/savings"}


def test_load_account_names_empty_when_no_accounts() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        ctx = ImportContext(s)
        assert ctx.load_account_names() == set()


# ---------------------------------------------------------------------------
# get_account_by_name
# ---------------------------------------------------------------------------


def test_get_account_by_name_returns_resource_name(session: Session) -> None:
    ctx = ImportContext(session)
    assert ctx.get_account_by_name("Assets:Bank:Checking") == "accounts/checking"


def test_get_account_by_name_returns_none_for_unknown(session: Session) -> None:
    ctx = ImportContext(session)
    assert ctx.get_account_by_name("Assets:Unknown") is None


# ---------------------------------------------------------------------------
# compute_pad
# ---------------------------------------------------------------------------


def test_compute_pad_delegates_to_service(session: Session) -> None:
    expected = PadResponse(
        account="accounts/checking",
        pad_date=date(2024, 6, 1),
        entries=[
            PadEntry(
                balance_assertion="balance_assertions/ba1",
                assertion_date=date(2024, 6, 1),
                units=MoneyValue(amount=Decimal("100"), symbol="CHF"),
            )
        ],
    )
    with patch(
        "family_ledger.importers.base.account_balance_service.compute_pad",
        return_value=expected,
    ) as mock_pad:
        ctx = ImportContext(session)
        result = ctx.compute_pad("accounts/checking", date(2024, 6, 1))

    mock_pad.assert_called_once_with(session, "accounts/checking", date(2024, 6, 1))
    assert result is expected


# ---------------------------------------------------------------------------
# create_and_upload_attachment
# ---------------------------------------------------------------------------


def test_create_and_upload_attachment_creates_record_without_upload_when_no_settings(
    session: Session,
) -> None:
    ctx = ImportContext(session, settings=None)
    with patch("family_ledger.importers.base.attachments_service.upload_attachment") as mock_upload:
        name = ctx.create_and_upload_attachment(
            account="accounts/checking",
            attachment_date=date(2024, 1, 15),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
            file_data=b"pdf-content",
        )

    assert name is not None
    mock_upload.assert_not_called()
    att = session.scalar(select(Attachment).where(Attachment.name == name))
    assert att is not None
    assert att.original_filename == "statement.pdf"


def test_create_and_upload_attachment_uploads_when_settings_configured(
    session: Session,
) -> None:
    settings = _make_settings()
    ctx = ImportContext(session, settings=settings)
    with patch("family_ledger.importers.base.attachments_service.upload_attachment") as mock_upload:
        name = ctx.create_and_upload_attachment(
            account="accounts/checking",
            attachment_date=date(2024, 1, 15),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
            file_data=b"pdf-content",
        )

    assert name is not None
    mock_upload.assert_called_once_with(
        session,
        settings,
        attachment_name=name,
        file_data=b"pdf-content",
        media_type="application/pdf",
        title=None,
    )


def test_create_and_upload_attachment_skips_upload_when_no_file_data(
    session: Session,
) -> None:
    ctx = ImportContext(session, settings=_make_settings())
    with patch("family_ledger.importers.base.attachments_service.upload_attachment") as mock_upload:
        name = ctx.create_and_upload_attachment(
            account="accounts/checking",
            attachment_date=date(2024, 1, 15),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
            file_data=None,
        )

    assert name is not None
    mock_upload.assert_not_called()


def test_create_and_upload_attachment_retries_upload_for_retryable_duplicate(
    session: Session,
) -> None:
    settings = _make_settings()
    ctx = ImportContext(session, settings=settings)

    # First call creates the record
    with patch("family_ledger.importers.base.attachments_service.upload_attachment"):
        first_name = ctx.create_and_upload_attachment(
            account="accounts/checking",
            attachment_date=date(2024, 1, 15),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
            file_data=b"pdf-content",
        )

    att = session.scalar(select(Attachment).where(Attachment.name == first_name))
    assert att is not None
    att.status = Attachment.STATUS_FAILED
    session.commit()

    # Second call is a duplicate — should retry the upload
    with patch("family_ledger.importers.base.attachments_service.upload_attachment") as mock_retry:
        second_name = ctx.create_and_upload_attachment(
            account="accounts/checking",
            attachment_date=date(2024, 1, 15),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
            file_data=b"pdf-content",
        )

    assert second_name is None  # duplicate → None
    mock_retry.assert_called_once()


def test_create_and_upload_attachment_skips_retry_for_stored_duplicate(
    session: Session,
) -> None:
    settings = _make_settings()
    ctx = ImportContext(session, settings=settings)

    with patch("family_ledger.importers.base.attachments_service.upload_attachment"):
        first_name = ctx.create_and_upload_attachment(
            account="accounts/checking",
            attachment_date=date(2024, 1, 15),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
            file_data=b"pdf-content",
        )

    att = session.scalar(select(Attachment).where(Attachment.name == first_name))
    assert att is not None
    att.status = Attachment.STATUS_STORED
    session.commit()

    with patch("family_ledger.importers.base.attachments_service.upload_attachment") as mock_retry:
        ctx.create_and_upload_attachment(
            account="accounts/checking",
            attachment_date=date(2024, 1, 15),
            original_filename="statement.pdf",
            media_type="application/pdf",
            document_url=None,
            entity_metadata={},
            file_data=b"pdf-content",
        )

    mock_retry.assert_not_called()
