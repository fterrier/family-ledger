from __future__ import annotations

import io
import zipfile
from collections.abc import Generator
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session

from family_ledger.config import Settings
from family_ledger.importers.base import ImportResult
from family_ledger.models import Account, BalanceAssertion, Base, Commodity, Price, Transaction
from family_ledger.models import Posting as PostingModel
from family_ledger.services.errors import ConflictError, UnavailableError

FIXTURE = """
option "operating_currency" "CHF"
option "inferred_tolerance_default" "CHF:0.005"

2020-01-01 open Assets:Bank:Checking:Family
2020-01-01 open Expenses:Food
2020-01-01 open Equity:Opening-Balances
2020-01-01 commodity CHF

2026-04-01 * "Migros" "Groceries"
  Assets:Bank:Checking:Family  -84.25 CHF
  Expenses:Food                 84.25 CHF

2026-04-02 price CHF 1 CHF
2026-04-03 balance Assets:Bank:Checking:Family -84.25 CHF
"""

MISSING_POSTING_FIXTURE = """
2020-01-01 open Assets:Bank:Checking:Family
2020-01-01 open Expenses:Food
2020-01-01 commodity CHF

2026-04-01 * "Migros" "Groceries"
  Assets:Bank:Checking:Family  -84.25 CHF
  Expenses:Food
"""

POSTING_COMMENT_FIXTURE = """
2020-01-01 open Assets:Bank:Checking:Family
2020-01-01 open Expenses:Food
2020-01-01 open Expenses:Tax
2020-01-01 commodity CHF

2026-04-01 * "Broker" "Dividend"
  Assets:Bank:Checking:Family  -84.25 CHF
  Expenses:Food                 80.00 CHF ; Groceries
  Expenses:Tax                   4.25 CHF ;
"""

COMMODITY_DISCOVERY_FIXTURE = """
2020-01-01 open Assets:Broker:AAPL AAPL
2020-01-01 open Assets:Cash:USD USD
2020-01-01 open Equity:Opening-Balances

2026-04-01 * "Buy AAPL"
  Assets:Broker:AAPL  1 AAPL {100.00 USD}
  Equity:Opening-Balances
"""

TOLERANCE_FIXTURE = """
2020-01-01 open Assets:Broker:Cash:USD
2020-01-01 open Assets:Broker:GOOG
2020-01-01 commodity USD
2020-01-01 commodity GOOG

2026-04-01 * "Buy GOOG"
  Assets:Broker:GOOG      1 GOOG {100.00 USD}
  Assets:Broker:Cash:USD -100.0000005 USD
"""

METADATA_FIXTURE = """
2020-01-01 open Assets:Bank:Checking:Family
2020-01-01 open Expenses:Food
2020-01-01 commodity CHF

2026-04-01 * "Migros" "Groceries"
  ref: "Z1234"
  account: "CH12345"
  Assets:Bank:Checking:Family  -84.25 CHF
  Expenses:Food                 84.25 CHF
"""

NATIVE_ID_METADATA_FIXTURE = """
2020-01-01 open Assets:Bank:Checking:Family
2020-01-01 open Expenses:Food
2020-01-01 commodity CHF

2026-04-01 * "Migros" "Groceries"
  source_native_id: "external:some-opaque-id"
  Assets:Bank:Checking:Family  -84.25 CHF
  Expenses:Food                 84.25 CHF
"""

PARSE_ERROR_FIXTURE = """
2020-01-01 open Assets:Bank
not valid beancount syntax !!!
"""

CUSTOM_ENTRY_FIXTURE = """
2020-01-01 open Assets:Bank:Checking
2020-01-01 commodity CHF

2026-04-01 custom "feature" "value"
"""


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
        yield s


def _run(session: Session, text: str) -> ImportResult:
    from family_ledger_importers.beancount import BeancountImporter

    return BeancountImporter().execute(session, {"ledger_file": text.encode("utf-8")}, {})


def _run_with_config(session: Session, text: str, config: dict[str, object]) -> ImportResult:
    from family_ledger_importers.beancount import BeancountImporter

    return BeancountImporter().execute(session, {"ledger_file": text.encode("utf-8")}, config)


def test_beancount_importer_populates_database(session: Session) -> None:
    result = _run(session, FIXTURE)

    assert result.entities["account"].created == 3
    assert result.entities["commodity"].created == 1
    assert result.entities["transaction"].created == 1
    assert result.entities["price"].created == 1
    assert result.entities["balance_assertion"].created == 1
    assert result.warnings == []

    assert session.scalar(select(func.count()).select_from(Account)) == 3
    assert session.scalar(select(func.count()).select_from(Commodity)) == 1
    assert session.scalar(select(func.count()).select_from(Transaction)) == 1
    assert session.scalar(select(func.count()).select_from(Price)) == 1
    assert session.scalar(select(func.count()).select_from(BalanceAssertion)) == 1


def test_beancount_importer_raises_on_parse_errors(session: Session) -> None:
    with pytest.raises(ConflictError) as exc_info:
        _run(session, PARSE_ERROR_FIXTURE)
    assert exc_info.value.code == "beancount_parse_error"


def test_beancount_importer_interpolates_missing_posting(session: Session) -> None:
    result = _run(session, MISSING_POSTING_FIXTURE)

    assert result.entities["transaction"].created == 1
    assert result.entities["transaction"].errors.count == 0


def test_beancount_importer_discovers_commodity_symbols_from_open_and_postings(
    session: Session,
) -> None:
    result = _run(session, COMMODITY_DISCOVERY_FIXTURE)

    assert result.entities["commodity"].created == 2
    assert session.scalar(select(func.count()).select_from(Commodity)) == 2


def test_beancount_importer_accepts_transaction_within_default_tolerance(
    session: Session,
) -> None:
    result = _run(session, TOLERANCE_FIXTURE)

    assert result.entities["transaction"].created == 1
    assert result.entities["transaction"].errors.count == 0


def test_beancount_importer_warns_on_unrecognized_entry_types(session: Session) -> None:
    result = _run(session, CUSTOM_ENTRY_FIXTURE)

    assert len(result.warnings) == 1
    assert "Custom" in result.warnings[0]
    assert "1 occurrences" in result.warnings[0]


def test_beancount_importer_unrecognized_entries_do_not_appear_in_entity_errors(
    session: Session,
) -> None:
    result = _run(session, CUSTOM_ENTRY_FIXTURE)

    assert "transaction" not in result.entities
    assert result.warnings != []


def test_beancount_importer_schema_exposes_posting_comment_config() -> None:
    from family_ledger_importers.beancount import BeancountImporter

    schema = BeancountImporter().get_schema()

    assert schema["properties"]["import_posting_comments_as_narration"]["default"] is False
    assert (
        "include directives are not supported"
        in schema["properties"]["import_posting_comments_as_narration"]["description"]
    )


def test_beancount_importer_ignores_posting_comments_by_default(session: Session) -> None:
    _run(session, POSTING_COMMENT_FIXTURE)

    transaction = session.scalar(select(Transaction))

    assert transaction is not None
    assert [posting.narration for posting in transaction.postings] == [None, None, None]


def test_beancount_importer_imports_posting_comments_when_enabled(session: Session) -> None:
    _run_with_config(
        session,
        POSTING_COMMENT_FIXTURE,
        {"import_posting_comments_as_narration": True},
    )

    transaction = session.scalar(select(Transaction))

    assert transaction is not None
    assert [posting.narration for posting in transaction.postings] == [None, "Groceries", None]


def test_beancount_importer_stores_beancount_metadata(session: Session) -> None:
    _run(session, METADATA_FIXTURE)

    transaction = session.scalar(select(Transaction))

    assert transaction is not None
    assert transaction.entity_metadata == {"beancount": {"ref": "Z1234", "account": "CH12345"}}


def test_beancount_importer_uses_ref_as_source_native_id(session: Session) -> None:
    _run(session, METADATA_FIXTURE)

    transaction = session.scalar(select(Transaction))

    assert transaction is not None
    assert transaction.source_native_id == "beancount:Z1234"


def test_beancount_importer_uses_source_native_id_metadata_directly(session: Session) -> None:
    _run(session, NATIVE_ID_METADATA_FIXTURE)

    transaction = session.scalar(select(Transaction))

    assert transaction is not None
    assert transaction.source_native_id == "external:some-opaque-id"


def test_beancount_importer_fallback_source_native_id_is_set_when_no_ref(
    session: Session,
) -> None:
    _run(session, FIXTURE)

    transaction = session.scalar(select(Transaction))

    assert transaction is not None
    assert transaction.entity_metadata == {}
    assert transaction.source_native_id is not None
    assert transaction.source_native_id.startswith("beancount:fp:")


def test_beancount_importer_fallback_source_native_id_is_deterministic(
    session: Session,
) -> None:
    from sqlalchemy import create_engine as _create_engine

    from family_ledger.models import Base as _Base

    engine2 = _create_engine("sqlite+pysqlite:///:memory:")
    _Base.metadata.create_all(engine2)
    with Session(engine2) as session2:
        _run(session2, FIXTURE)
        txn2 = session2.scalar(select(Transaction))
        assert txn2 is not None
        second_run_id = txn2.source_native_id

    _run(session, FIXTURE)
    txn1 = session.scalar(select(Transaction))
    assert txn1 is not None
    assert txn1.source_native_id == second_run_id


DUPLICATE_TRANSACTIONS_FIXTURE = """
2020-01-01 open Assets:Bank:Checking:Family
2020-01-01 open Expenses:Food
2020-01-01 commodity CHF

2026-04-01 * "Migros" "Groceries"
  Assets:Bank:Checking:Family  -50.00 CHF
  Expenses:Food                 50.00 CHF

2026-04-01 * "Migros" "Groceries"
  Assets:Bank:Checking:Family  -50.00 CHF
  Expenses:Food                 50.00 CHF
"""


def test_beancount_importer_duplicate_transactions_get_different_source_native_ids(
    session: Session,
) -> None:
    result = _run(session, DUPLICATE_TRANSACTIONS_FIXTURE)

    assert result.entities["transaction"].created == 2
    transactions = session.scalars(select(Transaction)).all()
    ids = [t.source_native_id for t in transactions]
    assert ids[0] != ids[1]
    assert all(id is not None and id.startswith("beancount:fp:") for id in ids)


# ---------------------------------------------------------------------------
# Pad directive import tests — cases verified against Beancount 3.2.0
# ---------------------------------------------------------------------------

PAD_BASIC_FIXTURE = """
2026-01-01 open Assets:Checking  USD
2026-01-01 open Equity:Opening   USD
2026-01-01 commodity USD

2026-01-01 pad Assets:Checking Equity:Opening
2026-01-02 balance Assets:Checking 1000.00 USD
"""

PAD_WITH_SAME_DATE_TX_FIXTURE = """
2026-01-01 open Assets:Checking  USD
2026-01-01 open Equity:Opening   USD
2026-01-01 open Income:Salary    USD
2026-01-01 commodity USD

2026-01-01 pad Assets:Checking Equity:Opening

2026-01-01 * "Salary"
  Assets:Checking   500.00 USD
  Income:Salary    -500.00 USD

2026-01-02 balance Assets:Checking 1000.00 USD
"""

PAD_WITH_NEXT_DAY_TX_FIXTURE = """
2026-01-01 open Assets:Checking  USD
2026-01-01 open Equity:Opening   USD
2026-01-01 open Income:Salary    USD
2026-01-01 commodity USD

2026-01-01 pad Assets:Checking Equity:Opening

2026-01-02 * "Salary"
  Assets:Checking   500.00 USD
  Income:Salary    -500.00 USD

2026-01-03 balance Assets:Checking 1000.00 USD
"""


def test_beancount_importer_basic_pad(session: Session) -> None:
    # Beancount test 1: no prior transactions, pad + balance → pad tx of 1000 USD
    result = _run(session, PAD_BASIC_FIXTURE)

    assert result.entities["balance_assertion"].created == 1
    assert result.entities["pad_transaction"].created == 1

    transactions = session.scalars(select(Transaction)).all()
    assert len(transactions) == 1
    pad_tx = transactions[0]
    assert pad_tx.narration == "Padding entry"
    assert pad_tx.transaction_date.isoformat() == "2026-01-01"
    assert pad_tx.entity_metadata.get("generated_by") == "pad"

    postings = session.scalars(
        select(PostingModel).where(PostingModel.transaction_id == pad_tx.id)
    ).all()
    amounts = {p.account.account_name: p.units_amount for p in postings}
    assert amounts["Assets:Checking"] == Decimal("1000.00")
    assert amounts["Equity:Opening"] == Decimal("-1000.00")


def test_beancount_importer_pad_with_same_date_transaction(session: Session) -> None:
    # Beancount test 2: real tx +500 on pad date → pad fills remaining 500
    result = _run(session, PAD_WITH_SAME_DATE_TX_FIXTURE)

    assert result.entities["pad_transaction"].created == 1

    pad_tx = session.scalar(select(Transaction).where(Transaction.narration == "Padding entry"))
    assert pad_tx is not None
    postings = session.scalars(
        select(PostingModel).where(PostingModel.transaction_id == pad_tx.id)
    ).all()
    checking_posting = next(p for p in postings if p.account.account_name == "Assets:Checking")
    assert checking_posting.units_amount == Decimal("500.00")


def test_beancount_importer_pad_with_next_day_transaction(session: Session) -> None:
    # Beancount test 5: real tx +500 on day after pad → pad still fills only 500
    result = _run(session, PAD_WITH_NEXT_DAY_TX_FIXTURE)

    assert result.entities["pad_transaction"].created == 1

    pad_tx = session.scalar(select(Transaction).where(Transaction.narration == "Padding entry"))
    assert pad_tx is not None
    assert pad_tx.transaction_date.isoformat() == "2026-01-01"
    postings = session.scalars(
        select(PostingModel).where(PostingModel.transaction_id == pad_tx.id)
    ).all()
    checking_posting = next(p for p in postings if p.account.account_name == "Assets:Checking")
    assert checking_posting.units_amount == Decimal("500.00")


def test_beancount_importer_pad_is_idempotent(session: Session) -> None:
    # Importing the same file twice must not create duplicate pad transactions
    _run(session, PAD_BASIC_FIXTURE)
    result2 = _run(session, PAD_BASIC_FIXTURE)

    assert result2.entities["pad_transaction"].duplicate == 1
    assert session.scalar(select(func.count()).select_from(Transaction)) == 1


PAD_MULTI_CURRENCY_FIXTURE = """
2020-01-01 open Assets:Checking
2020-01-01 open Equity:Opening
2020-01-01 commodity USD
2020-01-01 commodity CHF

2026-01-01 * "USD deposit"
  Assets:Checking   10.00 USD
  Equity:Opening   -10.00 USD

2026-01-01 * "CHF deposit"
  Assets:Checking   10.00 CHF
  Equity:Opening   -10.00 CHF

2026-01-02 pad Assets:Checking Equity:Opening

2026-01-03 balance Assets:Checking 20.00 USD
2026-01-03 balance Assets:Checking 20.00 CHF
"""


def test_beancount_importer_pad_multi_currency(session: Session) -> None:
    result = _run(session, PAD_MULTI_CURRENCY_FIXTURE)

    assert result.entities["pad_transaction"].created == 2

    from sqlalchemy import func as sqlfunc

    pad_count = session.scalar(
        select(sqlfunc.count())
        .select_from(Transaction)
        .where(Transaction.narration == "Padding entry")
    )
    assert pad_count == 2


def test_beancount_importer_pad_multi_currency_is_idempotent(session: Session) -> None:
    _run(session, PAD_MULTI_CURRENCY_FIXTURE)
    result2 = _run(session, PAD_MULTI_CURRENCY_FIXTURE)

    assert result2.entities["pad_transaction"].duplicate == 2
    from sqlalchemy import func as sqlfunc

    pad_count = session.scalar(
        select(sqlfunc.count())
        .select_from(Transaction)
        .where(Transaction.narration == "Padding entry")
    )
    assert pad_count == 2


# ---------------------------------------------------------------------------
# Archive (ZIP / TAR) import tests
# ---------------------------------------------------------------------------

ARCHIVE_BEANCOUNT = """
2020-01-01 open Assets:Bank:Checking
2020-01-01 commodity CHF

2019-02-25 document Assets:Bank:Checking "/old/path/on/disk/payslip.pdf"

2026-04-01 * "Migros" "Groceries"
  Assets:Bank:Checking  -10 CHF
  Expenses:Food          10 CHF

2020-01-01 open Expenses:Food
"""


def _make_zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _paperless_settings() -> Settings:
    return Settings(
        api_token="test",
        paperless_base_url="https://paperless.example.com",
        paperless_token="paperless-token",
    )


def _run_two_file(
    session: Session,
    ledger_text: str,
    documents_zip: bytes | None = None,
    settings: Settings | None = None,
) -> ImportResult:
    from family_ledger_importers.beancount import BeancountImporter

    files: dict[str, bytes] = {"ledger_file": ledger_text.encode()}
    if documents_zip is not None:
        files["documents_file"] = documents_zip
    return BeancountImporter().execute(session, files, {}, settings)


def test_beancount_importer_file_descriptors() -> None:
    from family_ledger_importers.beancount import BeancountImporter

    descriptors = BeancountImporter().get_file_descriptors()
    names = [d["name"] for d in descriptors]
    assert "ledger_file" in names
    assert "documents_file" in names
    ledger = next(d for d in descriptors if d["name"] == "ledger_file")
    assert ledger["required"] is True
    assert ".beancount" in ledger["accept"]
    docs = next(d for d in descriptors if d["name"] == "documents_file")
    assert docs["required"] is False
    assert ".zip" in docs["accept"]


def test_beancount_importer_imports_with_two_file_interface(session: Session) -> None:
    result = _run_two_file(session, ARCHIVE_BEANCOUNT)

    assert result.entities["transaction"].created == 1
    assert result.entities["account"].created == 2


def test_beancount_importer_imports_with_documents_zip(session: Session) -> None:
    docs_zip = _make_zip({"payslip.pdf": b"pdf-data"})
    result = _run_two_file(session, ARCHIVE_BEANCOUNT, documents_zip=docs_zip)

    assert result.entities["transaction"].created == 1


def test_beancount_importer_document_skipped_when_paperless_not_configured(
    session: Session,
) -> None:
    docs_zip = _make_zip({"payslip.pdf": b"pdf-data"})
    result = _run_two_file(session, ARCHIVE_BEANCOUNT, documents_zip=docs_zip, settings=None)

    assert "attachment" not in result.entities
    assert any("Paperless not configured" in w for w in result.warnings)


def test_beancount_importer_document_uploaded_from_documents_zip(
    session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger.services import attachments as attachments_service

    docs_zip = _make_zip({"payslip.pdf": b"pdf-data"})
    settings = _paperless_settings()
    captured: list[dict[str, Any]] = []

    def fake_create(s, cfg, **kwargs):  # type: ignore[no-untyped-def]
        captured.append(kwargs)
        return MagicMock(name="attachments/att_test")

    monkeypatch.setattr(attachments_service, "create_attachment", fake_create)

    result = _run_two_file(session, ARCHIVE_BEANCOUNT, documents_zip=docs_zip, settings=settings)

    assert result.entities["attachment"].created == 1
    assert result.entities["attachment"].errors.count == 0
    assert len(captured) == 1
    assert captured[0]["original_filename"] == "payslip.pdf"
    assert captured[0]["media_type"] == "application/pdf"
    assert captured[0]["attachment_date"].isoformat() == "2019-02-25"
    assert captured[0]["title"] is None


def test_beancount_importer_document_not_in_zip_counts_as_error(
    session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger.services import attachments as attachments_service

    # Documents zip doesn't contain the referenced payslip.pdf
    docs_zip = _make_zip({"other.pdf": b"other-data"})
    settings = _paperless_settings()
    monkeypatch.setattr(attachments_service, "create_attachment", lambda *a, **kw: None)

    result = _run_two_file(session, ARCHIVE_BEANCOUNT, documents_zip=docs_zip, settings=settings)

    assert result.entities["attachment"].errors.count == 1
    assert "payslip.pdf" in result.entities["attachment"].errors.examples[0]


def test_beancount_importer_document_upload_failure_counts_as_error(
    session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger.services import attachments as attachments_service

    docs_zip = _make_zip({"payslip.pdf": b"pdf-data"})
    settings = _paperless_settings()

    def raise_unavailable(*a, **kw):  # type: ignore[no-untyped-def]
        raise UnavailableError(code="paperless_unreachable", message="Paperless is unreachable")

    monkeypatch.setattr(attachments_service, "create_attachment", raise_unavailable)

    result = _run_two_file(session, ARCHIVE_BEANCOUNT, documents_zip=docs_zip, settings=settings)

    assert result.entities["attachment"].errors.count == 1
    assert "payslip.pdf" in result.entities["attachment"].errors.examples[0]


def test_beancount_importer_document_warns_without_documents_zip(session: Session) -> None:
    """Without a documents_file, Document directives emit an 'unrecognized entry' warning."""
    text = """
2020-01-01 open Assets:Bank
2020-01-01 commodity CHF
2019-02-25 document Assets:Bank "/path/to/doc.pdf"
"""
    result = _run(session, text)

    assert "attachment" not in result.entities
    assert any("Document" in w for w in result.warnings)


def test_beancount_importer_macos_metadata_skipped_in_documents_zip(
    session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger.services import attachments as attachments_service

    # Zip contains macOS resource fork alongside the real file
    docs_zip = _make_zip(
        {
            "__MACOSX/._payslip.pdf": b"macos-junk",
            "._payslip.pdf": b"more-junk",
            "payslip.pdf": b"pdf-data",
        }
    )
    settings = _paperless_settings()
    captured: list[dict[str, Any]] = []

    def fake_create(s, cfg, **kwargs):  # type: ignore[no-untyped-def]
        captured.append(kwargs)
        return MagicMock(name="attachments/att_test")

    monkeypatch.setattr(attachments_service, "create_attachment", fake_create)

    result = _run_two_file(session, ARCHIVE_BEANCOUNT, documents_zip=docs_zip, settings=settings)

    assert result.entities["attachment"].created == 1
    assert len(captured) == 1
    assert captured[0]["original_filename"] == "payslip.pdf"
