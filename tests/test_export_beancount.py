from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.config import LedgerConfig
from family_ledger.models import (
    Account,
    Attachment,
    BalanceAssertion,
    Commodity,
    Posting,
    Price,
    Transaction,
)
from family_ledger.scripts.export_beancount import (
    _format_document,
    _format_transaction,
    _meta_lines,
    export_beancount,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mk_account(account_name: str) -> Account:
    return Account(account_name=account_name)


def _mk_posting(
    account_name: str,
    amount: Decimal,
    symbol: str,
    *,
    cost_per_unit: Decimal | None = None,
    cost_symbol: str | None = None,
    price_per_unit: Decimal | None = None,
    price_symbol: str | None = None,
    narration: str | None = None,
) -> Posting:
    p = Posting(
        posting_order=0,
        units_amount=amount,
        units_symbol=symbol,
        cost_per_unit=cost_per_unit,
        cost_symbol=cost_symbol,
        price_per_unit=price_per_unit,
        price_symbol=price_symbol,
        narration=narration,
        entity_metadata={},
    )
    p.account = _mk_account(account_name)
    return p


def _mk_tx(
    tx_date: date,
    payee: str | None,
    narration: str | None,
    postings: list[Posting],
    *,
    source_native_id: str | None = None,
    entity_metadata: dict | None = None,
) -> Transaction:
    tx = Transaction(
        transaction_date=tx_date,
        name="transactions/txn_test",
        payee=payee,
        narration=narration,
        source_native_id=source_native_id,
        entity_metadata=entity_metadata or {},
    )
    tx.postings = postings
    return tx


# ---------------------------------------------------------------------------
# _meta_lines
# ---------------------------------------------------------------------------


def test_meta_lines_source_native_id_only() -> None:
    lines = _meta_lines("mt940:Z1234", {})
    assert lines == ['  source_native_id: "mt940:Z1234"']


def test_meta_lines_beancount_keys() -> None:
    lines = _meta_lines(None, {"ref": "Z1234", "account": "CH99"})
    assert '  ref: "Z1234"' in lines
    assert '  account: "CH99"' in lines


def test_meta_lines_skips_source_native_id_in_dict() -> None:
    lines = _meta_lines("mt940:Z1234", {"source_native_id": "other", "ref": "A"})
    assert lines[0] == '  source_native_id: "mt940:Z1234"'
    assert not any("other" in ln for ln in lines)


def test_meta_lines_skips_invalid_keys() -> None:
    lines = _meta_lines(None, {"InvalidKey": "v", "123bad": "v", "good_key": "v"})
    assert lines == ['  good_key: "v"']


def test_meta_lines_escapes_quotes_in_value() -> None:
    lines = _meta_lines(None, {"note": 'say "hello"'})
    assert lines == ['  note: "say \\"hello\\""']


def test_meta_lines_none_source_native_id_skipped() -> None:
    lines = _meta_lines(None, {})
    assert lines == []


# ---------------------------------------------------------------------------
# _format_transaction — header line
# ---------------------------------------------------------------------------


def test_format_transaction_payee_and_narration() -> None:
    tx = _mk_tx(date(2026, 4, 1), "Migros", "Groceries", [])
    out = _format_transaction(tx)
    assert out.startswith('2026-04-01 * "Migros" "Groceries"')


def test_format_transaction_narration_only() -> None:
    tx = _mk_tx(date(2026, 4, 1), None, "Salary", [])
    out = _format_transaction(tx)
    assert out.startswith('2026-04-01 * "Salary"')
    assert '"Salary"' in out
    # Should not have two quoted strings
    assert out.count('"') == 2


def test_format_transaction_no_payee_no_narration() -> None:
    tx = _mk_tx(date(2026, 4, 1), None, None, [])
    out = _format_transaction(tx)
    assert out.startswith('2026-04-01 * ""')


def test_format_transaction_null_narration_with_payee() -> None:
    tx = _mk_tx(date(2026, 4, 1), "Migros", None, [])
    out = _format_transaction(tx)
    assert out.startswith('2026-04-01 * "Migros" ""')


# ---------------------------------------------------------------------------
# _format_transaction — metadata
# ---------------------------------------------------------------------------


def test_format_transaction_source_native_id_in_output() -> None:
    tx = _mk_tx(date(2026, 4, 1), None, "Test", [], source_native_id="mt940:Z1234")
    out = _format_transaction(tx)
    assert '  source_native_id: "mt940:Z1234"' in out


def test_format_transaction_beancount_meta_emitted() -> None:
    tx = _mk_tx(
        date(2026, 4, 1),
        None,
        "Test",
        [],
        entity_metadata={"beancount": {"ref": "Z1234", "account": "CH99"}},
    )
    out = _format_transaction(tx)
    assert '  ref: "Z1234"' in out
    assert '  account: "CH99"' in out


def test_format_transaction_pad_metadata_emitted() -> None:
    tx = _mk_tx(
        date(2026, 1, 1),
        None,
        "Padding entry",
        [],
        entity_metadata={"generated_by": "pad", "source_account": "Equity:Opening"},
    )
    out = _format_transaction(tx)
    assert '  generated_by: "pad"' in out
    assert '  source_account: "Equity:Opening"' in out


# ---------------------------------------------------------------------------
# _format_transaction — postings and alignment
# ---------------------------------------------------------------------------


def test_format_transaction_basic_postings() -> None:
    postings = [
        _mk_posting("Assets:Checking", Decimal("-84.25"), "CHF"),
        _mk_posting("Expenses:Food", Decimal("84.25"), "CHF"),
    ]
    tx = _mk_tx(date(2026, 4, 1), "Migros", "Groceries", postings)
    out = _format_transaction(tx)
    lines = out.splitlines()
    assert any("Assets:Checking" in ln and "-84.25 CHF" in ln for ln in lines)
    assert any("Expenses:Food" in ln and "84.25 CHF" in ln for ln in lines)


def test_format_transaction_amounts_aligned() -> None:
    postings = [
        _mk_posting("Assets:Checking", Decimal("-84.25"), "CHF"),
        _mk_posting("Expenses:Food", Decimal("84.25"), "CHF"),
    ]
    tx = _mk_tx(date(2026, 4, 1), "Migros", "Groceries", postings)
    out = _format_transaction(tx)
    lines = out.splitlines()
    posting_lines = [ln for ln in lines if ln.startswith("  ") and not ln.startswith("  source")]
    # Amount column should start at the same position in both posting lines
    amount_col = [
        ln.index("-84.25") if "-84.25" in ln else ln.index("84.25") for ln in posting_lines
    ]
    assert amount_col[0] == amount_col[1]


def test_format_transaction_cost_annotation() -> None:
    postings = [
        _mk_posting(
            "Assets:Portfolio",
            Decimal("5"),
            "GOOG",
            cost_per_unit=Decimal("100"),
            cost_symbol="USD",
        ),
        _mk_posting("Assets:Cash", Decimal("-500"), "USD"),
    ]
    tx = _mk_tx(date(2026, 4, 1), None, "Buy GOOG", postings)
    out = _format_transaction(tx)
    assert "{100 USD}" in out


def test_format_transaction_price_annotation() -> None:
    postings = [
        _mk_posting(
            "Assets:Cash",
            Decimal("-100"),
            "USD",
            price_per_unit=Decimal("0.92"),
            price_symbol="CHF",
        ),
        _mk_posting("Assets:Checking", Decimal("92"), "CHF"),
    ]
    tx = _mk_tx(date(2026, 4, 1), None, "FX", postings)
    out = _format_transaction(tx)
    assert "@ 0.92 CHF" in out


def test_format_transaction_posting_narration_as_comment() -> None:
    postings = [
        _mk_posting("Assets:Checking", Decimal("-84.25"), "CHF"),
        _mk_posting("Expenses:Food", Decimal("84.25"), "CHF", narration="Groceries"),
    ]
    tx = _mk_tx(date(2026, 4, 1), "Migros", "Weekly shop", postings)
    out = _format_transaction(tx)
    assert "; Groceries" in out
    lines = out.splitlines()
    food_line = next(ln for ln in lines if "Expenses:Food" in ln)
    assert food_line.endswith("; Groceries")


def test_format_transaction_no_posting_narration_no_comment() -> None:
    postings = [_mk_posting("Assets:Checking", Decimal("-84.25"), "CHF")]
    tx = _mk_tx(date(2026, 4, 1), None, "Test", postings)
    out = _format_transaction(tx)
    assert ";" not in out


# ---------------------------------------------------------------------------
# _format_document
# ---------------------------------------------------------------------------


def _mk_attachment(
    *,
    account_name: str,
    attachment_date: date,
    original_filename: str,
    document_url: str | None = "https://paperless.example.com/api/documents/42/",
    entity_metadata: dict | None = None,
) -> Attachment:
    att = Attachment(
        name="attachments/att_test",
        attachment_date=attachment_date,
        original_filename=original_filename,
        media_type="application/pdf",
        status="stored",
        document_url=document_url,
        storage_backend="paperless",
        entity_metadata=entity_metadata or {},
        storage_metadata={},
    )
    att.account = _mk_account(account_name)
    return att


def test_format_document_basic() -> None:
    att = _mk_attachment(
        account_name="Assets:Bank:Checking",
        attachment_date=date(2026, 5, 19),
        original_filename="statement.pdf",
    )
    out = _format_document(att)
    assert out.startswith('2026-05-19 document Assets:Bank:Checking "statement.pdf"')
    assert '  document_url: "https://paperless.example.com/api/documents/42/"' in out


def test_format_document_emits_entity_metadata() -> None:
    att = _mk_attachment(
        account_name="Assets:Bank",
        attachment_date=date(2026, 5, 19),
        original_filename="pay.pdf",
        entity_metadata={"beancount": {"ref": "DOC-123"}},
    )
    out = _format_document(att)
    assert '  ref: "DOC-123"' in out


def test_format_document_document_url_comes_before_other_meta() -> None:
    att = _mk_attachment(
        account_name="Assets:Bank",
        attachment_date=date(2026, 5, 19),
        original_filename="pay.pdf",
        entity_metadata={"beancount": {"ref": "DOC-123"}},
    )
    lines = _format_document(att).splitlines()
    url_idx = next(i for i, ln in enumerate(lines) if "document_url" in ln)
    ref_idx = next(i for i, ln in enumerate(lines) if "ref" in ln)
    assert url_idx < ref_idx


def test_format_document_escapes_quotes_in_filename() -> None:
    att = _mk_attachment(
        account_name="Assets:Bank",
        attachment_date=date(2026, 5, 19),
        original_filename='say "hello".pdf',
    )
    out = _format_document(att)
    assert '\\"hello\\"' in out


# ---------------------------------------------------------------------------
# export_beancount — DB integration
# ---------------------------------------------------------------------------


@pytest.fixture
def export_session():
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    from family_ledger.models import Base

    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


_EXPORT_CONFIG = LedgerConfig.model_validate(
    {
        "default_currency": "CHF",
        "default_tolerance": "0.000001",
        "tolerance": {"CHF": "0.01"},
        "uncategorized_accounts": [],
    }
)


def test_export_beancount_emits_operating_currency_header(export_session: Session) -> None:
    output = export_beancount(export_session, _EXPORT_CONFIG)
    assert 'option "operating_currency" "CHF"' in output


def test_export_beancount_emits_commodity_directives(export_session: Session) -> None:
    export_session.add(Commodity(name="commodities/cmd_chf", symbol="CHF"))
    export_session.add(Commodity(name="commodities/cmd_usd", symbol="USD"))
    export_session.commit()

    output = export_beancount(export_session, _EXPORT_CONFIG)

    assert "2000-01-01 commodity CHF" in output
    assert "2000-01-01 commodity USD" in output


def test_export_beancount_emits_open_and_close_directives(export_session: Session) -> None:
    export_session.add(
        Account(
            name="accounts/acc_checking",
            account_name="Assets:Bank:Checking",
            effective_start_date=date(2020, 1, 1),
        )
    )
    export_session.add(
        Account(
            name="accounts/acc_old",
            account_name="Assets:Bank:Old",
            effective_start_date=date(2018, 1, 1),
            effective_end_date=date(2022, 12, 31),
        )
    )
    export_session.commit()

    output = export_beancount(export_session, _EXPORT_CONFIG)

    assert "2020-01-01 open Assets:Bank:Checking" in output
    assert "2018-01-01 open Assets:Bank:Old" in output
    assert "2022-12-31 close Assets:Bank:Old" in output


def test_export_beancount_emits_price_directives(export_session: Session) -> None:
    export_session.add(
        Price(
            name="prices/p_1",
            base_symbol="USD",
            quote_symbol="CHF",
            price_date=date(2026, 4, 1),
            price_per_unit=Decimal("0.92"),
            entity_metadata={},
        )
    )
    export_session.commit()

    output = export_beancount(export_session, _EXPORT_CONFIG)

    assert any("price USD" in line and "CHF" in line for line in output.splitlines())


def test_export_beancount_emits_transactions(export_session: Session) -> None:
    checking = Account(
        name="accounts/acc_checking",
        account_name="Assets:Bank:Checking",
        effective_start_date=date(2020, 1, 1),
    )
    food = Account(
        name="accounts/acc_food",
        account_name="Expenses:Food",
        effective_start_date=date(2020, 1, 1),
    )
    export_session.add_all([checking, food])
    export_session.flush()

    p1 = Posting(
        posting_order=1,
        units_amount=Decimal("-84.25"),
        units_symbol="CHF",
        entity_metadata={},
    )
    p1.account = checking
    p2 = Posting(
        posting_order=2,
        units_amount=Decimal("84.25"),
        units_symbol="CHF",
        entity_metadata={},
    )
    p2.account = food

    txn = Transaction(
        name="transactions/txn_1",
        transaction_date=date(2026, 4, 1),
        payee="Migros",
        narration="Groceries",
        source_native_id="ref-1",
        entity_metadata={},
    )
    txn.postings = [p1, p2]
    export_session.add(txn)
    export_session.commit()

    output = export_beancount(export_session, _EXPORT_CONFIG)

    assert '2026-04-01 * "Migros" "Groceries"' in output
    assert "Assets:Bank:Checking" in output
    assert "Expenses:Food" in output
    assert "CHF" in output
    assert 'source_native_id: "ref-1"' in output


def test_export_beancount_emits_balance_assertions(export_session: Session) -> None:
    checking = Account(
        name="accounts/acc_checking",
        account_name="Assets:Bank:Checking",
        effective_start_date=date(2020, 1, 1),
    )
    export_session.add(checking)
    export_session.flush()

    ba = BalanceAssertion(
        name="balanceAssertions/ba_1",
        assertion_date=date(2026, 4, 30),
        amount=Decimal("1500.00"),
        symbol="CHF",
        entity_metadata={},
    )
    ba.account = checking
    export_session.add(ba)
    export_session.commit()

    output = export_beancount(export_session, _EXPORT_CONFIG)

    assert any(
        "balance Assets:Bank:Checking" in line and "CHF" in line for line in output.splitlines()
    )


def _make_attachment(
    account: Account, *, name: str, filename: str, status: str, document_url: str | None = None
) -> Attachment:
    att = Attachment(
        name=name,
        attachment_date=date(2026, 5, 1),
        original_filename=filename,
        media_type="application/pdf",
        status=status,
        document_url=document_url,
        storage_backend="paperless",
        storage_deadline_at=datetime(2026, 6, 1, tzinfo=timezone.utc).replace(tzinfo=None),
        entity_metadata={},
        storage_metadata={},
    )
    att.account = account
    return att


def test_export_beancount_emits_document_directives_for_stored_attachments(
    export_session: Session,
) -> None:
    checking = Account(
        name="accounts/acc_checking",
        account_name="Assets:Bank:Checking",
        effective_start_date=date(2020, 1, 1),
    )
    export_session.add(checking)
    export_session.flush()

    att = _make_attachment(
        checking,
        name="attachments/att_1",
        filename="statement.pdf",
        status="stored",
        document_url="https://paperless.example.com/api/documents/42/",
    )
    export_session.add(att)
    export_session.commit()

    output = export_beancount(export_session, _EXPORT_CONFIG)

    assert '2026-05-01 document Assets:Bank:Checking "statement.pdf"' in output
    assert "paperless.example.com" in output


def test_export_beancount_excludes_pending_attachments(export_session: Session) -> None:
    checking = Account(
        name="accounts/acc_checking",
        account_name="Assets:Bank:Checking",
        effective_start_date=date(2020, 1, 1),
    )
    export_session.add(checking)
    export_session.flush()

    att = _make_attachment(
        checking,
        name="attachments/att_pending",
        filename="pending.pdf",
        status="pending_upload",
    )
    export_session.add(att)
    export_session.commit()

    output = export_beancount(export_session, _EXPORT_CONFIG)

    assert "pending.pdf" not in output
