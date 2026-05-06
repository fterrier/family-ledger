from __future__ import annotations

from datetime import date
from decimal import Decimal

from family_ledger.models import Account, Posting, Transaction
from family_ledger.scripts.export_beancount import _format_transaction, _meta_lines

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
