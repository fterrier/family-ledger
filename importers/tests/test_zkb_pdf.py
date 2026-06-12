from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from family_ledger_importers import zkb_pdf as zkb_pdf_module
from family_ledger_importers.zkb_pdf import (
    ParsedZkbEntry,
    ParsedZkbStatement,
    ZkbPdfImporter,
    _extract_metadata,
    _extract_ref,
    _format_payee,
    _parse_amount,
    _parse_date_2y,
    _parse_text_lines,
)
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, selectinload

from family_ledger.importers.base import ImportContext
from family_ledger.models import Account, BalanceAssertion, Base, Commodity, Transaction

IBAN = "CH5700700114901427045"
ACCOUNT_RESOURCE = "accounts/zkb_family"
ACCOUNT_NAME = "Assets:Liquid:ZKB:Checking:Family"

BASE_CONFIG = {"account_mappings": {IBAN: ACCOUNT_RESOURCE}}


def _make_entry(
    *,
    transaction_date: date = date(2026, 2, 2),
    value_date: date | None = date(2026, 1, 29),
    effective_date: date | None = None,
    amount: Decimal = Decimal("-323.70"),
    description: str = "Belastung TWINT: COOP.CH SPREITENBACH",
    ref: str | None = None,
    currency: str = "CHF",
) -> ParsedZkbEntry:
    eff = effective_date or (max(transaction_date, value_date) if value_date else transaction_date)
    return ParsedZkbEntry(
        account_iban=IBAN,
        transaction_date=transaction_date,
        value_date=value_date,
        effective_date=eff,
        amount=amount,
        currency=currency,
        description=description,
        ref=ref,
    )


def _make_stmt(
    entries: list[ParsedZkbEntry] | None = None,
    *,
    statement_date: date = date(2026, 2, 28),
    closing_amount: Decimal = Decimal("86570.88"),
) -> ParsedZkbStatement:
    return ParsedZkbStatement(
        entries=entries or [],
        account_iban=IBAN,
        statement_date=statement_date,
        closing_amount=closing_amount,
        closing_currency="CHF",
    )


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
        s.add(
            Account(
                name=ACCOUNT_RESOURCE,
                account_name=ACCOUNT_NAME,
                effective_start_date=date(2020, 1, 1),
                effective_end_date=None,
                entity_metadata={},
            )
        )
        s.add(Commodity(name="commodities/CHF", symbol="CHF", entity_metadata={}))
        s.commit()
        yield s


def _run(
    session: Session,
    entries: list[ParsedZkbEntry] | None = None,
    config: dict | None = None,
    stmt: ParsedZkbStatement | None = None,
) -> None:
    if stmt is None:
        stmt = _make_stmt(entries or [])
    cfg = config if config is not None else BASE_CONFIG
    with patch.object(zkb_pdf_module, "_parse_pdf_bytes", return_value=stmt):
        ZkbPdfImporter().execute(
            ImportContext(session),
            {"file": b"fake-pdf"},
            cfg,
            None,
        )


# --- Schema / descriptor tests ---


def test_get_schema_has_account_mappings() -> None:
    schema = ZkbPdfImporter().get_schema()

    assert "account_mappings" in schema["properties"]
    assert schema["properties"]["account_mappings"]["type"] == "object"


def test_get_file_descriptors_returns_pdf() -> None:
    descriptors = ZkbPdfImporter().get_file_descriptors()

    assert len(descriptors) == 1
    assert descriptors[0]["name"] == "file"
    assert "application/pdf" in descriptors[0]["accept"]
    assert descriptors[0]["required"] is True


# --- Pure parsing unit tests ---


def test_parse_amount_plain() -> None:
    assert _parse_amount("323.70") == Decimal("323.70")


def test_parse_amount_thousands_apostrophe() -> None:
    assert _parse_amount("2'992.55") == Decimal("2992.55")
    assert _parse_amount("80'190.63") == Decimal("80190.63")


def test_parse_date_2y() -> None:
    assert _parse_date_2y("02.02.26") == date(2026, 2, 2)
    assert _parse_date_2y("31.01.26") == date(2026, 1, 31)


def test_extract_ref_z_prefix() -> None:
    assert _extract_ref("Belastung (1) eBill, Auftrags-Nr. Z260348427385") == "Z260348427385"


def test_extract_ref_ek_prefix() -> None:
    assert _extract_ref("Gutschrift, Auftrags-Nr. EK2602105D833A7B") == "EK2602105D833A7B"


def test_extract_ref_numeric_returns_none() -> None:
    # TWINT rows use sequential "Auftrags-Nr. 1" — not a real ref
    assert _extract_ref("Belastung TWINT: COOP.CH, Auftrags-Nr. 1") is None
    assert _extract_ref("Gutschrift TWINT: PFEIFER, Auftrags-Nr. 2") is None


def test_extract_ref_no_auftrags_nr() -> None:
    assert _extract_ref("Einkauf ZKB Visa Debit Card Nr. xxxx 4462 Coop-3304") is None


def test_format_payee_strips_auftrags_nr() -> None:
    result = _format_payee("Belastung (1) eBill, Auftrags-Nr. Z260348427385")
    assert result == "Belastung (1) eBill"


def test_format_payee_strips_numeric_auftrags_nr() -> None:
    result = _format_payee("Belastung TWINT: COOP.CH SPREITENBACH, Auftrags-Nr. 1")
    assert result == "COOP.CH SPREITENBACH - Belastung TWINT"


def test_format_payee_with_continuation() -> None:
    desc = "Belastung (1) eBill, Auftrags-Nr. Z260348427385 Viseca Payment Services AG 8050 Zürich"
    result = _format_payee(desc)
    assert result == "Viseca Payment Services AG 8050 Zürich - Belastung (1) eBill"


def test_format_payee_mobile_banking() -> None:
    desc = "Belastung (1) Mobile Banking Stadt Zürich Schulgesundheitsdienst 8027 Zürich CH"
    assert (
        _format_payee(desc)
        == "Stadt Zürich Schulgesundheitsdienst 8027 Zürich CH - Belastung (1) Mobile Banking"
    )


def test_format_payee_dauerauftrag() -> None:
    desc = "Belastung (2) Dauerauftrag ERSIAN AG Schaeronmoosstrasse 77 8052 Zürich CH"
    assert (
        _format_payee(desc)
        == "ERSIAN AG Schaeronmoosstrasse 77 8052 Zürich CH - Belastung (2) Dauerauftrag"
    )


def test_format_payee_einkauf_card_pdf_single_line() -> None:
    desc = "Einkauf ZKB Visa Debit Card Nr. xxxx 4462 Babus Bakery Coffeeh 0000 Zuerich"
    assert (
        _format_payee(desc)
        == "Babus Bakery Coffeeh 0000 Zuerich - Einkauf ZKB Visa Debit Card Nr. xxxx 4462"
    )


def test_format_payee_einkauf_card_no_body_unchanged() -> None:
    desc = "Einkauf ZKB Visa Debit Card Nr. xxxx 4462"
    assert _format_payee(desc) == desc


# --- _parse_text_lines unit tests ---

# Synthetic PDF text lines for unit testing the line parser.
SAMPLE_LINES = [
    # Page header (should be skipped)
    "Konto-Nr. 1149-1427.045",
    "IBAN CH57 0070 0114 9014 2704 5",
    "Datum Geschäftsvorgang Preis Belastung Gutschrift Valuta Saldo",
    # Opening balance
    "31.01.26 Saldovortrag 0.00 80'190.63",
    # Debit
    "02.02.26 Belastung TWINT: 6003 - COOP.CH SPREITENBACH, Auftrags-Nr. 1"
    " 323.70 29.01.26 79'866.93",
    # Debit with continuation
    "03.02.26 Belastung (1) eBill, Auftrags-Nr. Z260348427385 2'992.55 03.02.26 76'874.38",
    "Viseca Payment Services AG Hagenholzstrasse 56 8050 Zürich CH",
    # Credit
    "25.02.26 Salär, Auftrags-Nr. Z260563260006 12'835.85 25.02.26 89'710.23",
    # Summary (should be skipped, not appended)
    "Additionen 0.00 13'603.54 19'983.79",
    "Schlusssaldo zu Ihren Gunsten 89'710.23",
    # QR code footer (should be skipped)
    "ANAMHKENFLALFLAJGKAJDIELEJFJEOGNEIGK AJCJFIGDAOKPNANJJKAAIKCMIMFGOMGAABLK",
]


def test_parse_lines_debit_creates_negative_amount() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    twint = next(e for e in entries if "COOP" in e.description)
    assert twint.amount == Decimal("-323.70")


def test_parse_lines_credit_creates_positive_amount() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    salary = next(e for e in entries if "Salär" in e.description)
    assert salary.amount > 0


def test_parse_lines_saldovortrag_skipped() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    assert all("Saldovortrag" not in e.description for e in entries)


def test_parse_lines_multiline_description_joined() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    ebill = next(e for e in entries if "eBill" in e.description)
    assert "Viseca Payment Services AG" in ebill.description


def test_parse_lines_schlusssaldo_not_appended() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    assert all("Schlusssaldo" not in e.description for e in entries)


def test_parse_lines_additionen_not_appended() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    assert all("Additionen" not in e.description for e in entries)


def test_parse_lines_ref_extracted() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    ebill = next(e for e in entries if "eBill" in e.description)
    assert ebill.ref == "Z260348427385"


def test_parse_lines_twint_ref_is_none() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    twint = next(e for e in entries if "COOP" in e.description)
    assert twint.ref is None


def test_parse_lines_effective_date_uses_max_of_txn_and_valuta() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    # TWINT: txn=02.02.26, valuta=29.01.26 → effective=02.02.26
    twint = next(e for e in entries if "COOP" in e.description)
    assert twint.transaction_date == date(2026, 2, 2)
    assert twint.value_date == date(2026, 1, 29)
    assert twint.effective_date == date(2026, 2, 2)


def test_parse_lines_total_count() -> None:
    entries = _parse_text_lines(SAMPLE_LINES, IBAN, "CHF")

    assert len(entries) == 3  # TWINT debit, eBill, Salär


def test_parse_lines_page_header_not_appended() -> None:
    # Page header lines between transactions (simulating cross-page continuation)
    lines = [
        "31.01.26 Saldovortrag 0.00 80'190.63",
        "02.02.26 Belastung TWINT: COOP.CH, Auftrags-Nr. 1 323.70 29.01.26 79'866.93",
        # Page break header (should be skipped, not appended to prior or next entry)
        "Konto-Nr. 1149-1427.045",
        "IBAN CH57 0070 0114 9014 2704 5",
        "Datum Geschäftsvorgang Preis Belastung Gutschrift Valuta Saldo",
        "25.02.26 Salär, Auftrags-Nr. Z260563260006 12'835.85 25.02.26 90'184.18",
    ]
    entries = _parse_text_lines(lines, IBAN, "CHF")

    assert len(entries) == 2
    assert "Konto-Nr" not in entries[0].description
    assert "IBAN" not in entries[0].description
    assert "Konto-Nr" not in entries[1].description


def test_parse_lines_continuation_after_page_break() -> None:
    # Continuation line for the last transaction appears on the next page,
    # after a QR-code footer and page header — must not be lost.
    lines = [
        "31.01.26 Saldovortrag 0.00 80'190.63",
        "02.02.26 Belastung (1) eBill, Auftrags-Nr. Z260348427385 2'992.55 02.02.26 77'198.08",
        # QR-code footer (last line of page N)
        "ANAMHKENFLALFLAJGKAJDIELEJFJEOGNEIGK AJCJFIGDAOKPNANJJKAAIKCMIMFGOMGAABLK",
        # Page header on next page
        "Konto-Nr. 1149-1427.045",
        "Datum Geschäftsvorgang Preis Belastung Gutschrift Valuta Saldo",
        # Continuation of the eBill entry — must be captured despite the page break
        "Viseca Payment Services AG Hagenholzstrasse 56 8050 Zürich CH",
        "Additionen 0.00 2'992.55 0.00",
        "Schlusssaldo zu Ihren Lasten 77'198.08",
    ]
    entries = _parse_text_lines(lines, IBAN, "CHF")

    assert len(entries) == 1
    assert "Viseca Payment Services AG" in entries[0].description


# --- _extract_metadata unit tests ---

SAMPLE_PDF_TEXT = """
IBAN CH57 0070 0114 9014 2704 5
Währung: Schweizer Franken (CHF)
Auszug per 28.02.2026
Schlusssaldo zu Ihren Gunsten 86'570.88
"""


def test_extract_metadata_parses_iban() -> None:
    iban, _, _, _ = _extract_metadata(SAMPLE_PDF_TEXT)
    assert iban == "CH5700700114901427045"


def test_extract_metadata_parses_statement_date() -> None:
    _, stmt_date, _, _ = _extract_metadata(SAMPLE_PDF_TEXT)
    assert stmt_date == date(2026, 2, 28)


def test_extract_metadata_parses_closing_balance() -> None:
    _, _, closing, _ = _extract_metadata(SAMPLE_PDF_TEXT)
    assert closing == Decimal("86570.88")


def test_extract_metadata_parses_currency_from_pdf() -> None:
    _, _, _, currency = _extract_metadata(SAMPLE_PDF_TEXT)
    assert currency == "CHF"


def test_extract_metadata_missing_currency_raises() -> None:
    text = (
        "IBAN CH57 0070 0114 9014 2704 5\nAuszug per 28.02.2026"
        "\nSchlusssaldo zu Ihren Gunsten 86'570.88"
    )
    with pytest.raises(Exception, match="Currency not found"):
        _extract_metadata(text)


# --- Integration / importer tests ---


def test_debit_creates_negative_posting(session: Session) -> None:
    entry = _make_entry(amount=Decimal("-323.70"))
    _run(session, [entry])

    txn = session.execute(select(Transaction)).scalar_one()
    assert txn.postings[0].units_amount == Decimal("-323.70")
    assert txn.postings[0].units_symbol == "CHF"


def test_credit_creates_positive_posting(session: Session) -> None:
    entry = _make_entry(amount=Decimal("12835.85"))
    _run(session, [entry])

    txn = session.execute(select(Transaction)).scalar_one()
    assert txn.postings[0].units_amount == Decimal("12835.85")


def test_source_native_id_uses_ref(session: Session) -> None:
    entry = _make_entry(ref="Z260348427385")
    _run(session, [entry])

    txn = session.execute(select(Transaction)).scalar_one()
    assert txn.source_native_id == "zkb_pdf:Z260348427385"


def test_source_native_id_fingerprint_when_no_ref(session: Session) -> None:
    entry = _make_entry(ref=None)
    _run(session, [entry])

    txn = session.execute(select(Transaction)).scalar_one()
    assert txn.source_native_id is not None and txn.source_native_id.startswith("zkb_pdf:fp:")


def test_entity_metadata_structure(session: Session) -> None:
    entry = _make_entry(ref="Z260348427385", value_date=date(2026, 1, 29))
    _run(session, [entry])

    txn = session.execute(select(Transaction)).scalar_one()
    meta = txn.entity_metadata["zkb_pdf"]
    assert meta["account_iban"] == IBAN
    assert meta["transaction_date"] == "2026-02-02"
    assert meta["effective_date"] == "2026-02-02"
    assert meta["value_date"] == "2026-01-29"
    assert meta["ref"] == "Z260348427385"


def test_entity_metadata_no_value_date_or_ref(session: Session) -> None:
    entry = _make_entry(ref=None, value_date=None, effective_date=date(2026, 2, 2))
    _run(session, [entry])

    txn = session.execute(select(Transaction)).scalar_one()
    meta = txn.entity_metadata["zkb_pdf"]
    assert "value_date" not in meta
    assert "ref" not in meta


def test_balance_assertion_created(session: Session) -> None:
    _run(
        session,
        stmt=_make_stmt(closing_amount=Decimal("86570.88"), statement_date=date(2026, 2, 28)),
    )

    ba = session.scalars(
        select(BalanceAssertion).options(selectinload(BalanceAssertion.account))
    ).one()
    assert ba.assertion_date == date(2026, 3, 1)
    assert ba.amount == Decimal("86570.88")
    assert ba.symbol == "CHF"
    assert ba.account.name == ACCOUNT_RESOURCE


def test_balance_assertion_metadata(session: Session) -> None:
    _run(session, stmt=_make_stmt(statement_date=date(2026, 2, 28)))

    ba = session.execute(select(BalanceAssertion)).scalar_one()
    assert ba.entity_metadata["zkb_pdf"]["account_iban"] == IBAN
    assert ba.entity_metadata["zkb_pdf"]["statement_date"] == "2026-02-28"


def test_reimport_is_idempotent(session: Session) -> None:
    entry = _make_entry(ref="Z260348427385")
    stmt = _make_stmt([entry])

    _run(session, stmt=stmt)
    _run(session, stmt=stmt)

    txns = session.execute(select(Transaction)).scalars().all()
    assert len(txns) == 1


def test_reimport_fingerprint_is_idempotent(session: Session) -> None:
    entry = _make_entry(ref=None)
    stmt = _make_stmt([entry])

    _run(session, stmt=stmt)
    _run(session, stmt=stmt)

    txns = session.execute(select(Transaction)).scalars().all()
    assert len(txns) == 1


def test_account_mapping_missing_raises(session: Session) -> None:
    config = {"account_mappings": {}}
    with pytest.raises(Exception, match="Missing account_mappings"):
        _run(session, config=config, stmt=_make_stmt([_make_entry()]))


def test_account_mapping_unknown_account_raises(session: Session) -> None:
    config = {"account_mappings": {IBAN: "accounts/nonexistent"}}
    with pytest.raises(Exception, match="not found"):
        _run(session, config=config, stmt=_make_stmt([_make_entry()]))
