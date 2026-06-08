from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from family_ledger_importers import viseca as viseca_module
from family_ledger_importers.viseca import (
    ParsedVisecaEntry,
    ParsedVisecaSection,
    ParsedVisecaStatement,
    VisecaImporter,
    _compute_amount,
    _parse_rows,
    _parse_statement,
)
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session, selectinload

from family_ledger.importers.base import ImportContext
from family_ledger.models import Account, BalanceAssertion, Base, Commodity, Transaction

VISA_ACCOUNT_NAME = "Liabilities:Cumulus:Visa"
VISA_ACCOUNT_RESOURCE = "accounts/visa"
VISA2_ACCOUNT_NAME = "Liabilities:Cumulus:Visa2"
VISA2_ACCOUNT_RESOURCE = "accounts/visa2"

VISECA_CONFIG = {"cards": {"0000": VISA_ACCOUNT_RESOURCE}}

FILENAME = b"visebpp_20250414_400_51-55_1107568108543212_886.pdf"


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
                name=VISA_ACCOUNT_RESOURCE,
                account_name=VISA_ACCOUNT_NAME,
                effective_start_date=date(2020, 1, 1),
                effective_end_date=None,
                entity_metadata={},
            )
        )
        s.add(
            Account(
                name=VISA2_ACCOUNT_RESOURCE,
                account_name=VISA2_ACCOUNT_NAME,
                effective_start_date=date(2020, 1, 1),
                effective_end_date=None,
                entity_metadata={},
            )
        )
        s.add(Commodity(name="commodities/CHF", symbol="CHF", entity_metadata={}))
        s.commit()
        yield s


def _make_stmt(
    entries: list[ParsedVisecaEntry],
    card_last4: str = "0000",
    total_due_chf: Decimal | None = None,
) -> ParsedVisecaStatement:
    return ParsedVisecaStatement(
        preamble_entries=[],
        sections=[ParsedVisecaSection(card_last4, entries, None)],
        total_due_chf=total_due_chf,
    )


def _run(
    session: Session,
    entries: list[ParsedVisecaEntry],
    config: dict = VISECA_CONFIG,
    settings=None,
) -> None:
    stmt = _make_stmt(entries)
    with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
        VisecaImporter().execute(
            ImportContext(session),
            {"file": b"fake-pdf", "__filename__file__": FILENAME},
            config,
            settings,
        )


# --- Schema / descriptor tests ---


def test_get_schema_has_cards_property() -> None:
    schema = VisecaImporter().get_schema()

    assert "cards" in schema["properties"]
    assert "additionalProperties" in schema["properties"]["cards"]


def test_get_file_descriptors_returns_single_pdf_descriptor() -> None:
    descriptors = VisecaImporter().get_file_descriptors()

    assert len(descriptors) == 1
    assert descriptors[0]["name"] == "file"
    assert "application/pdf" in descriptors[0]["accept"]
    assert descriptors[0]["required"] is True


# --- _parse_rows unit tests ---


def test_parse_rows_single_expense_row() -> None:
    rows = [("15.02.25", "17.02.25", "OPENAI SUBSCR", "", "", "20.25")]

    entries = _parse_rows(rows)  # type: ignore[arg-type]

    assert len(entries) == 1
    assert entries[0].value_date == "17.02.25"
    assert entries[0].amount_str == "20.25"
    assert entries[0].details == "OPENAI SUBSCR"


def test_parse_rows_credit_has_dash_suffix() -> None:
    rows = [("06.03.25", "15.02.25", "Votre paiement - Merci", "", "", "31.75 -")]

    entries = _parse_rows(rows)  # type: ignore[arg-type]

    assert len(entries) == 1
    assert entries[0].amount_str == "31.75 -"


def test_parse_rows_multiline_details_concatenated() -> None:
    rows = [
        ("15.02.25", "17.02.25", "OPENAI SUBSCR, OPENAI.COM US", "", "", "20.25"),
        ("", "", "Logiciels informatiques", "", "", ""),
        ("", "", "Taux de conversion 0.9362432 du 15.02.25", "", "", ""),
    ]

    entries = _parse_rows(rows)  # type: ignore[arg-type]

    assert len(entries) == 1
    assert entries[0].details == (
        "OPENAI SUBSCR, OPENAI.COM US Logiciels informatiques "
        "Taux de conversion 0.9362432 du 15.02.25"
    )


def test_parse_rows_skips_header_with_amount_but_no_date() -> None:
    rows = [
        ("", "Date de", "", "", "", "Montant en"),
        ("15.02.25", "17.02.25", "OPENAI", "", "", "20.25"),
    ]

    entries = _parse_rows(rows)  # type: ignore[arg-type]

    assert len(entries) == 1
    assert entries[0].details == "OPENAI"


def test_parse_rows_skips_total_row_with_amount_no_date() -> None:
    rows = [
        ("15.02.25", "17.02.25", "OPENAI", "", "", "20.25"),
        ("", "", "Total carte XYZ", "", "", "32.80"),
    ]

    entries = _parse_rows(rows)  # type: ignore[arg-type]

    assert len(entries) == 1


def test_parse_rows_skips_card_info_row() -> None:
    rows = [
        ("4435 92X", "X XXXX", "Carte de crédit Cumulus", "", "", ""),
        ("15.02.25", "17.02.25", "OPENAI", "", "", "20.25"),
    ]

    entries = _parse_rows(rows)  # type: ignore[arg-type]

    assert len(entries) == 1


def test_parse_rows_skips_footer_text_after_last_transaction() -> None:
    rows = [
        ("10.10.25", "10.10.25", "APPLE.COM/BILL", "", "", "3.00"),
        ("", "", "Biens numériques", "", "", ""),  # valid continuation
        ("Informat", "ions sur", "le programme de bonus", "", "", ""),  # footer → skip
        ("Numéro C", "umulus 2", "099554963648", "", "", ""),  # footer → skip
    ]

    entries = _parse_rows(rows)  # type: ignore[arg-type]

    assert len(entries) == 1
    assert entries[0].details == "APPLE.COM/BILL Biens numériques"


def test_parse_rows_multiple_transactions() -> None:
    rows = [
        ("15.02.25", "17.02.25", "OPENAI", "", "", "20.25"),
        ("10.03.25", "11.03.25", "HEROKU", "", "", "6.35"),
    ]

    entries = _parse_rows(rows)  # type: ignore[arg-type]

    assert len(entries) == 2
    assert entries[0].value_date == "17.02.25"
    assert entries[1].value_date == "11.03.25"


# --- _parse_statement unit tests ---


def test_parse_statement_detects_card_sections() -> None:
    rows = [
        ("4435 92X", "X XXXX", "3644 Carte de crédit Cumulus, F Terrier", "", "", ""),
        ("15.02.25", "17.02.25", "OPENAI", "", "", "20.25"),
        ("10.03.25", "11.03.25", "HEROKU", "", "", "6.35"),
        ("", "", "Total carte Carte de crédit Cumulus 4435 92XX XXXX 3644", "", "", "26.60"),
        ("", "", "Montant dû", "", "", "26.60"),
    ]

    stmt = _parse_statement(rows)  # type: ignore[arg-type]

    assert len(stmt.sections) == 1
    assert stmt.sections[0].card_last4 == "3644"
    assert len(stmt.sections[0].entries) == 2
    assert stmt.sections[0].total_chf == Decimal("26.60")


def test_parse_statement_captures_total_due() -> None:
    rows = [
        ("4435 92X", "X XXXX", "3644 Carte de crédit Cumulus, F Terrier", "", "", ""),
        ("15.02.25", "17.02.25", "OPENAI", "", "", "20.25"),
        ("", "", "Total carte Carte de crédit Cumulus 4435 92XX XXXX 3644", "", "", "20.25"),
        ("", "", "Montant dû", "", "", "20.25"),
    ]

    stmt = _parse_statement(rows)  # type: ignore[arg-type]

    assert stmt.total_due_chf == Decimal("20.25")


def test_parse_statement_preamble_entries_before_card_section() -> None:
    rows = [
        ("06.03.25", "15.02.25", "Votre paiement - Merci", "", "", "31.75 -"),
        ("4435 92X", "X XXXX", "3644 Carte de crédit Cumulus, F Terrier", "", "", ""),
        ("15.02.25", "17.02.25", "OPENAI", "", "", "20.25"),
        ("", "", "Total carte Carte de crédit Cumulus 4435 92XX XXXX 3644", "", "", "20.25"),
        ("", "", "Montant dû", "", "", "20.25"),
    ]

    stmt = _parse_statement(rows)  # type: ignore[arg-type]

    assert len(stmt.preamble_entries) == 1
    assert stmt.preamble_entries[0].details == "Votre paiement - Merci"
    assert len(stmt.sections[0].entries) == 1


def test_parse_statement_two_card_sections() -> None:
    rows = [
        ("4435 92X", "X XXXX", "3644 Carte de crédit Cumulus, F Terrier", "", "", ""),
        ("15.02.25", "17.02.25", "OPENAI", "", "", "20.25"),
        ("", "", "Total carte Carte de crédit Cumulus 4435 92XX XXXX 3644", "", "", "20.25"),
        ("4435 92X", "X XXXX", "5293 Carte de crédit Cumulus, Other Person", "", "", ""),
        ("10.03.25", "11.03.25", "HEROKU", "", "", "6.35"),
        ("", "", "Total carte Carte de crédit Cumulus 4435 92XX XXXX 5293", "", "", "6.35"),
        ("", "", "Montant dû", "", "", "26.60"),
    ]

    stmt = _parse_statement(rows)  # type: ignore[arg-type]

    assert len(stmt.sections) == 2
    assert stmt.sections[0].card_last4 == "3644"
    assert stmt.sections[0].total_chf == Decimal("20.25")
    assert stmt.sections[1].card_last4 == "5293"
    assert stmt.sections[1].total_chf == Decimal("6.35")
    assert stmt.total_due_chf == Decimal("26.60")


def test_parse_statement_thousand_separator_in_total() -> None:
    rows = [
        ("4435 92X", "X XXXX", "3644 Carte de crédit Cumulus, F Terrier", "", "", ""),
        ("", "", "Total carte Carte de crédit Cumulus 4435 92XX XXXX 3644", "", "", "1'900.70"),
        ("", "", "Montant dû", "", "", "1'900.70"),
    ]

    stmt = _parse_statement(rows)  # type: ignore[arg-type]

    assert stmt.sections[0].total_chf == Decimal("1900.70")
    assert stmt.total_due_chf == Decimal("1900.70")


def test_parse_statement_credit_total_has_negative_sign() -> None:
    rows = [
        ("4435 92X", "X XXXX", "3644 Carte de crédit Cumulus, F Terrier", "", "", ""),
        ("", "", "Total carte Carte de crédit Cumulus 4435 92XX XXXX 3644", "", "", "50.05 -"),
    ]

    stmt = _parse_statement(rows)  # type: ignore[arg-type]

    assert stmt.sections[0].total_chf == Decimal("-50.05")


# --- _compute_amount unit tests ---


def test_compute_amount_expense_is_negative() -> None:
    assert _compute_amount("20.25") == Decimal("-20.25")


def test_compute_amount_credit_is_positive() -> None:
    assert _compute_amount("31.75 -") == Decimal("31.75")


def test_compute_amount_strips_thousand_separator() -> None:
    assert _compute_amount("1'784.75") == Decimal("-1784.75")


def test_compute_amount_large_credit() -> None:
    assert _compute_amount("805.20 -") == Decimal("805.20")


# --- execute() integration tests ---


def test_execute_raises_if_account_not_found(session: Session) -> None:
    from family_ledger.services.errors import ValidationError

    with pytest.raises(ValidationError) as exc_info:
        VisecaImporter().execute(
            ImportContext(session),
            {"file": b""},
            {"cards": {"3644": "accounts/nonexistent"}},
        )

    assert exc_info.value.code == "account_not_found"


def test_execute_raises_unknown_card_if_cards_missing(session: Session) -> None:
    from family_ledger.services.errors import ValidationError

    stmt = _make_stmt([], card_last4="3644")
    with pytest.raises(ValidationError) as exc_info:
        with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
            VisecaImporter().execute(
                ImportContext(session),
                {"file": b"fake-pdf", "__filename__file__": FILENAME},
                {},
            )

    assert exc_info.value.code == "unknown_card"
    assert "3644" in exc_info.value.message


def test_execute_raises_unknown_card_lists_all_missing(session: Session) -> None:
    from family_ledger.services.errors import ValidationError

    stmt = ParsedVisecaStatement(
        preamble_entries=[],
        sections=[
            ParsedVisecaSection("3644", [], None),
            ParsedVisecaSection("5293", [], None),
        ],
        total_due_chf=None,
    )
    with pytest.raises(ValidationError) as exc_info:
        with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
            VisecaImporter().execute(
                ImportContext(session),
                {"file": b"fake-pdf", "__filename__file__": FILENAME},
                {},
            )

    assert exc_info.value.code == "unknown_card"
    assert "3644" in exc_info.value.message
    assert "5293" in exc_info.value.message


def test_execute_raises_on_unknown_card(session: Session) -> None:
    from family_ledger.services.errors import ValidationError

    stmt = ParsedVisecaStatement(
        preamble_entries=[],
        sections=[
            ParsedVisecaSection("9999", [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")], None)
        ],
        total_due_chf=None,
    )

    with pytest.raises(ValidationError) as exc_info:
        with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
            VisecaImporter().execute(
                ImportContext(session),
                {"file": b"fake-pdf", "__filename__file__": FILENAME},
                {"cards": {"3644": VISA_ACCOUNT_RESOURCE}},
            )

    assert exc_info.value.code == "unknown_card"
    assert "9999" in exc_info.value.message


def test_execute_creates_single_posting_transactions(session: Session) -> None:
    entries = [
        ParsedVisecaEntry("17.02.25", "20.25", "OPENAI SUBSCR"),
        ParsedVisecaEntry("11.03.25", "6.35", "HEROKU FEB"),
    ]

    _run(session, entries)

    transactions = session.scalars(
        select(Transaction).options(selectinload(Transaction.postings))
    ).all()
    assert len(transactions) == 2
    for txn in transactions:
        assert len(txn.postings) == 1
        assert txn.postings[0].units_symbol == "CHF"


def test_execute_transaction_dates_use_value_date(session: Session) -> None:
    entries = [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")]

    _run(session, entries)

    txn = session.scalars(select(Transaction)).one()
    assert txn.transaction_date == date(2025, 2, 17)


def test_execute_transaction_details_set_as_payee(session: Session) -> None:
    entries = [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI SUBSCR")]

    _run(session, entries)

    txn = session.scalars(select(Transaction)).one()
    assert txn.payee == "OPENAI SUBSCR"
    assert txn.narration is None


def test_execute_transaction_amounts_are_negative_for_expenses(session: Session) -> None:
    entries = [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")]

    _run(session, entries)

    txn = session.scalars(select(Transaction).options(selectinload(Transaction.postings))).one()
    assert txn.postings[0].units_amount == Decimal("-20.25")


def test_execute_transaction_amounts_are_positive_for_credits(session: Session) -> None:
    entries = [ParsedVisecaEntry("15.02.25", "31.75 -", "Votre paiement - Merci")]

    _run(session, entries)

    txn = session.scalars(select(Transaction).options(selectinload(Transaction.postings))).one()
    assert txn.postings[0].units_amount == Decimal("31.75")


def test_execute_deduplication_skips_second_import(session: Session) -> None:
    entries = [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")]
    stmt = _make_stmt(entries)

    _run(session, entries)
    ctx = ImportContext(session)
    with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
        result = VisecaImporter().execute(
            ctx,
            {"file": b"fake-pdf", "__filename__file__": FILENAME},
            VISECA_CONFIG,
        )

    assert result.entities["transaction"].created == 0
    assert result.entities["transaction"].duplicate == 1


def test_execute_creates_attachment_when_settings_provided(session: Session) -> None:
    entries = [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")]
    stmt = _make_stmt(entries)
    settings = MagicMock()

    with (
        patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt),
        patch("family_ledger_importers.viseca.attachment_service.upload_attachment"),
    ):
        ctx = ImportContext(session)
        result = VisecaImporter().execute(
            ctx,
            {"file": b"fake-pdf", "__filename__file__": FILENAME},
            VISECA_CONFIG,
            settings,
        )

    assert result.entities.get("attachment") is not None
    assert result.entities["attachment"].created == 1


def test_execute_statement_date_parsed_from_filename(session: Session) -> None:
    entries = [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")]
    stmt = _make_stmt(entries)
    settings = MagicMock()

    with (
        patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt),
        patch("family_ledger_importers.viseca.attachment_service.upload_attachment"),
    ):
        VisecaImporter().execute(
            ImportContext(session),
            {"file": b"fake-pdf", "__filename__file__": FILENAME},
            VISECA_CONFIG,
            settings,
        )

    from family_ledger.models import Attachment

    att = session.scalars(select(Attachment)).one()
    assert att.attachment_date == date(2025, 4, 14)


# --- Balance assertion tests ---


def test_execute_creates_balance_assertion_for_single_card(session: Session) -> None:
    stmt = ParsedVisecaStatement(
        preamble_entries=[],
        sections=[
            ParsedVisecaSection(
                "0000", [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")], Decimal("20.25")
            )
        ],
        total_due_chf=Decimal("20.25"),
    )

    with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
        VisecaImporter().execute(
            ImportContext(session),
            {"file": b"fake-pdf", "__filename__file__": FILENAME},
            VISECA_CONFIG,
        )

    bal = session.scalars(select(BalanceAssertion)).one()
    assert bal.assertion_date == date(2025, 4, 14)
    assert bal.amount == Decimal("-20.25")
    assert bal.symbol == "CHF"


def test_execute_no_balance_assertion_when_total_absent(session: Session) -> None:
    entries = [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")]
    _run(session, entries)  # _make_stmt always uses total_due_chf=None

    count = session.scalar(select(func.count()).select_from(BalanceAssertion))
    assert count == 0


def test_execute_single_balance_assertion_when_cards_share_account(session: Session) -> None:
    stmt = ParsedVisecaStatement(
        preamble_entries=[],
        sections=[
            ParsedVisecaSection(
                "3644", [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")], Decimal("20.25")
            ),
            ParsedVisecaSection(
                "5293", [ParsedVisecaEntry("11.03.25", "6.35", "HEROKU")], Decimal("6.35")
            ),
        ],
        total_due_chf=Decimal("26.60"),
    )
    config = {"cards": {"3644": VISA_ACCOUNT_RESOURCE, "5293": VISA_ACCOUNT_RESOURCE}}

    with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
        VisecaImporter().execute(
            ImportContext(session),
            {"file": b"fake-pdf", "__filename__file__": FILENAME},
            config,
        )

    bals = session.scalars(select(BalanceAssertion)).all()
    assert len(bals) == 1
    assert bals[0].amount == Decimal("-26.60")


def test_execute_per_card_balance_assertions_for_multi_account(session: Session) -> None:
    stmt = ParsedVisecaStatement(
        preamble_entries=[],
        sections=[
            ParsedVisecaSection(
                "3644", [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")], Decimal("20.25")
            ),
            ParsedVisecaSection(
                "5293", [ParsedVisecaEntry("11.03.25", "6.35", "HEROKU")], Decimal("6.35")
            ),
        ],
        total_due_chf=Decimal("26.60"),
    )
    config = {"cards": {"3644": VISA_ACCOUNT_RESOURCE, "5293": VISA2_ACCOUNT_RESOURCE}}

    with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
        VisecaImporter().execute(
            ImportContext(session),
            {"file": b"fake-pdf", "__filename__file__": FILENAME},
            config,
        )

    bals = session.scalars(select(BalanceAssertion)).all()
    assert len(bals) == 2
    amounts = {bal.account.name: bal.amount for bal in bals}
    assert amounts[VISA_ACCOUNT_RESOURCE] == Decimal("-20.25")
    assert amounts[VISA2_ACCOUNT_RESOURCE] == Decimal("-6.35")


def test_execute_routes_transactions_per_card(session: Session) -> None:
    stmt = ParsedVisecaStatement(
        preamble_entries=[],
        sections=[
            ParsedVisecaSection("3644", [ParsedVisecaEntry("17.02.25", "20.25", "OPENAI")], None),
            ParsedVisecaSection("5293", [ParsedVisecaEntry("11.03.25", "6.35", "HEROKU")], None),
        ],
        total_due_chf=None,
    )
    config = {"cards": {"3644": VISA_ACCOUNT_RESOURCE, "5293": VISA2_ACCOUNT_RESOURCE}}

    with patch.object(viseca_module, "_parse_pdf_bytes", return_value=stmt):
        VisecaImporter().execute(
            ImportContext(session),
            {"file": b"fake-pdf", "__filename__file__": FILENAME},
            config,
        )

    txns = session.scalars(select(Transaction).options(selectinload(Transaction.postings))).all()
    assert len(txns) == 2
    account_names = {txn.postings[0].account.name for txn in txns}
    assert account_names == {VISA_ACCOUNT_RESOURCE, VISA2_ACCOUNT_RESOURCE}
