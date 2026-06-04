from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from family_ledger_importers import ibkr as ibkr_importer
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, selectinload

from family_ledger.importers.base import ImportContext
from family_ledger.models import Account, BalanceAssertion, Base, Posting, Transaction
from family_ledger.services.errors import ValidationError

# ---------------------------------------------------------------------------
# Minimal Flex XML templates
# ---------------------------------------------------------------------------

_FLEX_HEADER = b"""<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Test" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U12345" fromDate="2024-01-01" toDate="2024-01-31"
                   period="Monthly" whenGenerated="20240201;120000">
"""
_FLEX_FOOTER = b"""
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>"""


def _flex_xml(
    *,
    cash_report: str = "",
    open_positions: str = "",
    trades: str = "",
    cash_transactions: str = "",
) -> bytes:
    return (
        _FLEX_HEADER
        + f"""
      <CashReport>{cash_report}</CashReport>
      <OpenPositions>{open_positions}</OpenPositions>
      <Trades>{trades}</Trades>
      <CashTransactions>{cash_transactions}</CashTransactions>
""".encode()
        + _FLEX_FOOTER
    )


_SEND_RESPONSE = b"""<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="20240201;120000">
  <Status>Success</Status>
  <ReferenceCode>99999</ReferenceCode>
  <Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url>
</FlexStatementResponse>"""


# ---------------------------------------------------------------------------
# Session fixture and helpers
# ---------------------------------------------------------------------------


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


_account_counter = 0


def _create_account(session: Session, account_name: str) -> str:
    global _account_counter
    _account_counter += 1
    account = Account(
        name=f"accounts/test-{_account_counter}",
        account_name=account_name,
        effective_start_date=date(2019, 1, 1),
        effective_end_date=None,
        entity_metadata={},
    )
    session.add(account)
    session.commit()
    return account.name


def _base_accounts(session: Session) -> dict[str, Any]:
    return {
        "cash_accounts": {
            "USD": _create_account(session, "Assets:Liquid:IBKR:Depot:USD"),
            "CHF": _create_account(session, "Assets:Liquid:IBKR:Depot:CHF"),
        },
        "commissions_account": _create_account(session, "Expenses:Financial:Commissions:IBKR"),
        "fees_account": _create_account(session, "Expenses:Financial:Fees:IBKR"),
        "profit_loss_account": _create_account(session, "Income:ProfitLoss:IBKR"),
        "interest_account": _create_account(session, "Income:Interests:IBKR"),
        "withholding_tax_account": _create_account(
            session, "Assets:AccountsReceivable:Taxes:USWithholding"
        ),
        "stock_accounts": {},
        "dividend_accounts": {},
        "token": "test-token",
        "query_id": "12345",
    }


def _run(session: Session, xml_data: bytes, config: dict[str, Any]) -> ibkr_importer.ImportResult:
    def fake_fetch(token: str, query_id: str) -> bytes:
        return xml_data

    with patch.object(ibkr_importer, "_fetch_flex_xml", side_effect=fake_fetch):
        return ibkr_importer.IbkrImporter().execute(ImportContext(session), {}, config)


def _transactions(session: Session) -> list[Transaction]:
    return list(
        session.scalars(
            select(Transaction)
            .options(selectinload(Transaction.postings).selectinload(Posting.account))
            .order_by(Transaction.transaction_date, Transaction.id)
        ).all()
    )


def _balance_assertions(session: Session) -> list[BalanceAssertion]:
    return list(
        session.scalars(
            select(BalanceAssertion)
            .options(selectinload(BalanceAssertion.account))
            .order_by(BalanceAssertion.assertion_date, BalanceAssertion.id)
        ).all()
    )


def _postings_summary(tx: Transaction) -> list[dict[str, Any]]:
    return [
        {
            "account": p.account.account_name,
            "amount": str(p.units_amount),
            "symbol": p.units_symbol,
        }
        for p in tx.postings
    ]


# ---------------------------------------------------------------------------
# API fetch tests
# ---------------------------------------------------------------------------


def test_fetch_flex_statement_retries_on_processing() -> None:
    send_resp = _SEND_RESPONSE
    processing_resp = b"""<?xml version="1.0"?>
<FlexStatementResponse>
  <Status>Processing</Status>
</FlexStatementResponse>"""
    final_xml = _flex_xml(
        cash_report='<CashReportCurrency currency="USD" endingCash="100" />',
    )

    call_count = 0

    def fake_urlopen(req, timeout=None):
        nonlocal call_count
        call_count += 1
        mock = MagicMock()
        mock.__enter__ = MagicMock(return_value=mock)
        mock.__exit__ = MagicMock(return_value=False)
        if call_count == 1:
            mock.read.return_value = send_resp
        elif call_count == 2:
            mock.read.return_value = processing_resp
        else:
            mock.read.return_value = final_xml
        return mock

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        with patch("time.sleep"):
            result = ibkr_importer._fetch_flex_xml("tok", "qid")
    assert result == final_xml
    assert call_count == 3


def test_fetch_flex_statement_fails_on_api_error() -> None:
    error_resp = b"""<?xml version="1.0"?>
<FlexStatementResponse>
  <Status>Fail</Status>
  <ErrorMessage>Invalid token</ErrorMessage>
</FlexStatementResponse>"""

    mock = MagicMock()
    mock.__enter__ = MagicMock(return_value=mock)
    mock.__exit__ = MagicMock(return_value=False)
    mock.read.return_value = error_resp

    with patch("urllib.request.urlopen", return_value=mock):
        with pytest.raises(ValidationError, match="Invalid token"):
            ibkr_importer._fetch_flex_xml("bad-token", "qid")


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def test_importer_schema_has_required_fields() -> None:
    schema = ibkr_importer.IbkrImporter().get_schema()
    props = schema["properties"]
    assert "token" in props
    assert "query_id" in props
    assert "cash_accounts" in props
    assert "stock_accounts" in props
    assert "dividend_accounts" in props
    assert "commissions_account" in props
    assert "withholding_tax_account" in props


def test_importer_has_no_file_descriptors() -> None:
    assert ibkr_importer.IbkrImporter().get_file_descriptors() == []


# ---------------------------------------------------------------------------
# Dividend transactions
# ---------------------------------------------------------------------------


def test_dividend_with_withholding(session: Session) -> None:
    config = _base_accounts(session)
    vti_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:VTI")
    vti_div = _create_account(session, "Income:Dividends:IBKR:VTI")
    config["stock_accounts"]["VTI"] = vti_stock
    config["dividend_accounts"]["VTI"] = vti_div

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="USD" symbol="VTI"
          type="Dividends" amount="50.00" reportDate="2024-01-20"
          transactionID="DIV001" description="VTI Cash Dividend USD 0.5 per Share" />
        <CashTransaction accountId="U12345" currency="USD" symbol="VTI"
          type="Withholding Tax" amount="-7.50" reportDate="2024-01-20"
          transactionID="WH001" description="VTI Cash Dividend - US Tax" />
        """,
    )

    result = _run(session, xml, config)

    assert result.entities["transaction"].created == 1
    txs = _transactions(session)
    assert len(txs) == 1
    tx = txs[0]
    assert tx.transaction_date == date(2024, 1, 20)
    assert tx.source_native_id == "ibkr:DIV001"

    posting_accounts = [p.account.account_name for p in tx.postings]
    posting_amounts = {p.account.account_name: p.units_amount for p in tx.postings}

    assert "Assets:Liquid:IBKR:Depot:USD" in posting_accounts
    assert "Assets:AccountsReceivable:Taxes:USWithholding" in posting_accounts
    assert "Income:Dividends:IBKR:VTI" in posting_accounts

    # Dividend posting: +50 USD to cash
    usd_postings = [
        p for p in tx.postings if p.account.account_name == "Assets:Liquid:IBKR:Depot:USD"
    ]
    assert any(p.units_amount == Decimal("50.00") for p in usd_postings)
    # Withholding posting: -7.50 USD from cash
    assert any(p.units_amount == Decimal("-7.50") for p in usd_postings)
    # Withholding receivable: +7.50 USD
    wh = posting_amounts["Assets:AccountsReceivable:Taxes:USWithholding"]
    assert wh == Decimal("7.50")


def test_dividend_without_withholding(session: Session) -> None:
    config = _base_accounts(session)
    vti_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:VTI")
    vti_div = _create_account(session, "Income:Dividends:IBKR:VTI")
    config["stock_accounts"]["VTI"] = vti_stock
    config["dividend_accounts"]["VTI"] = vti_div

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="USD" symbol="VTI"
          type="Dividends" amount="50.00" reportDate="2024-01-20"
          transactionID="DIV001" description="VTI Cash Dividend" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    posting_accounts = {p.account.account_name for p in txs[0].postings}
    assert "Assets:AccountsReceivable:Taxes:USWithholding" not in posting_accounts
    assert "Income:Dividends:IBKR:VTI" in posting_accounts


def test_dividend_correction_negative_amounts(session: Session) -> None:
    config = _base_accounts(session)
    vti_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:VTI")
    vti_div = _create_account(session, "Income:Dividends:IBKR:VTI")
    config["stock_accounts"]["VTI"] = vti_stock
    config["dividend_accounts"]["VTI"] = vti_div

    # Correction: negative dividend + positive withholding reversal
    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="USD" symbol="VTI"
          type="Dividends" amount="-50.00" reportDate="2024-02-01"
          transactionID="COR001" description="Reversal VTI Cash Dividend" />
        <CashTransaction accountId="U12345" currency="USD" symbol="VTI"
          type="Withholding Tax" amount="7.50" reportDate="2024-02-01"
          transactionID="COR002" description="Reversal VTI - US Tax" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    usd_postings = [
        p for p in txs[0].postings if p.account.account_name == "Assets:Liquid:IBKR:Depot:USD"
    ]
    assert any(p.units_amount == Decimal("-50.00") for p in usd_postings)
    # Withholding: wh_amount is +7.50, so cash gets +7.50 and withholding account gets -7.50
    assert any(p.units_amount == Decimal("7.50") for p in usd_postings)


def test_dividend_skipped_when_no_dividend_account_mapping(session: Session) -> None:
    config = _base_accounts(session)
    # No stock_accounts or dividend_accounts for VTI

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="USD" symbol="VTI"
          type="Dividends" amount="50.00" reportDate="2024-01-20"
          transactionID="DIV001" description="VTI Cash Dividend" />
        """,
    )

    result = _run(session, xml, config)
    assert len(_transactions(session)) == 0
    assert any("VTI" in w for w in result.warnings)


def test_multiple_withholding_corrections_same_date_symbol(session: Session) -> None:
    # Year-end scenario: multiple WHTAX entries on same date/symbol (no matching dividend)
    config = _base_accounts(session)

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="USD" symbol="BND"
          type="Withholding Tax" amount="1.50" reportDate="2025-01-01"
          transactionID="WH101" description="BND Cash Dividend USD 0.21188 per Share - US Tax" />
        <CashTransaction accountId="U12345" currency="USD" symbol="BND"
          type="Withholding Tax" amount="2.30" reportDate="2025-01-01"
          transactionID="WH102" description="BND Cash Dividend USD 0.20232 per Share - US Tax" />
        <CashTransaction accountId="U12345" currency="USD" symbol="BND"
          type="Withholding Tax" amount="-0.40" reportDate="2025-01-01"
          transactionID="WH103" description="BND Cash Dividend USD 0.18297 per Share - US Tax" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    # All three WHTs are merged into one transaction
    assert len(txs) == 1
    tx = txs[0]
    # Total withholding = 1.50 + 2.30 + -0.40 = 3.40
    wh_account = "Assets:AccountsReceivable:Taxes:USWithholding"
    wh_posting = next(p for p in tx.postings if p.account.account_name == wh_account)
    assert wh_posting.units_amount == Decimal("-3.40")
    # Cash receives the total as well (opposite sign)
    usd_posting = next(
        p for p in tx.postings if p.account.account_name == "Assets:Liquid:IBKR:Depot:USD"
    )
    assert usd_posting.units_amount == Decimal("3.40")
    # source_native_id uses first withholding transactionID
    assert tx.source_native_id == "ibkr:WH101"


# ---------------------------------------------------------------------------
# Interest
# ---------------------------------------------------------------------------


def test_interest_transaction(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="USD" symbol=""
          type="Broker Interest Received" amount="14.12" reportDate="2024-01-31"
          transactionID="INT001" description="USD Credit Interest for Dec-2023" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    tx = txs[0]
    assert tx.narration == "USD Credit Interest for Dec-2023"
    assert tx.source_native_id == "ibkr:INT001"
    postings = {p.account.account_name: p.units_amount for p in tx.postings}
    assert postings.get("Assets:Liquid:IBKR:Depot:USD") == Decimal("14.12")
    assert "Income:Interests:IBKR" in postings


# ---------------------------------------------------------------------------
# Fees
# ---------------------------------------------------------------------------


def test_fee_transaction(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="CHF" symbol=""
          type="Other Fees" amount="-8.98" reportDate="2024-01-31"
          transactionID="FEE001" description="Balance of Monthly Minimum Fee for Jan 2024" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    postings = {p.account.account_name: p.units_amount for p in txs[0].postings}
    assert postings.get("Assets:Liquid:IBKR:Depot:CHF") == Decimal("-8.98")
    assert "Expenses:Financial:Fees:IBKR" in postings


# ---------------------------------------------------------------------------
# Deposits / Withdrawals
# ---------------------------------------------------------------------------


def test_deposit_creates_two_posting_transaction(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="CHF" symbol=""
          type="Deposits &amp; Withdrawals" amount="5000.00" reportDate="2024-01-05"
          transactionID="DEP001" description="Transfer of CHF Cash" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    tx = txs[0]
    assert tx.narration == "Transfer of CHF Cash"
    assert len(tx.postings) == 1
    assert tx.postings[0].account.account_name == "Assets:Liquid:IBKR:Depot:CHF"
    assert tx.postings[0].units_amount == Decimal("5000.00")


def test_withdrawal_transaction(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="CHF" symbol=""
          type="Deposits &amp; Withdrawals" amount="-10000.00" reportDate="2024-01-10"
          transactionID="WD001" description="Transfer of CHF Cash" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    postings = {p.account.account_name: p.units_amount for p in txs[0].postings}
    assert postings.get("Assets:Liquid:IBKR:Depot:CHF") == Decimal("-10000.00")


# ---------------------------------------------------------------------------
# Stock buy
# ---------------------------------------------------------------------------


def test_stock_buy(session: Session) -> None:
    config = _base_accounts(session)
    vti_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:VTI")
    config["stock_accounts"]["VTI"] = vti_stock

    xml = _flex_xml(
        trades="""
        <Trade accountId="U12345" currency="USD" symbol="VTI" assetCategory="STK"
          buySell="BUY" quantity="33" tradePrice="146.06" tradeMoney="-4819.98"
          ibCommission="-1.00" ibCommissionCurrency="USD"
          transactionID="TX001" ibOrderID="ORD001"
          tradeDate="2024-01-15" reportDate="2024-01-15"
          cost="-4819.98" fifoPnlRealized="0" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    tx = txs[0]
    assert tx.narration == "Buying VTI"
    assert tx.source_native_id == "ibkr:order:ORD001"
    assert tx.transaction_date == date(2024, 1, 15)

    posting_map = {p.account.account_name: p for p in tx.postings}
    vti_posting = posting_map["Assets:SemiLiquid:Shares:IBKR:VTI"]
    assert vti_posting.units_amount == Decimal("33")
    assert vti_posting.units_symbol == "VTI"
    assert vti_posting.cost_per_unit == Decimal("146.06")
    assert vti_posting.cost_symbol == "USD"

    # Cash debit
    usd_postings = [
        p for p in tx.postings if p.account.account_name == "Assets:Liquid:IBKR:Depot:USD"
    ]
    cash_debit = next(p for p in usd_postings if p.units_amount == Decimal("-4819.98"))
    assert cash_debit is not None

    # Commission
    comm = posting_map["Expenses:Financial:Commissions:IBKR"]
    assert comm.units_amount == Decimal("1.00")


def test_stock_buy_skipped_when_no_stock_account(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        trades="""
        <Trade accountId="U12345" currency="USD" symbol="VTI" assetCategory="STK"
          buySell="BUY" quantity="10" tradePrice="200.00" tradeMoney="-2000.00"
          ibCommission="-1.00" ibCommissionCurrency="USD"
          transactionID="TX001" ibOrderID="ORD001"
          tradeDate="2024-01-15" reportDate="2024-01-15"
          cost="-2000.00" fifoPnlRealized="0" />
        """,
    )

    result = _run(session, xml, config)
    assert len(_transactions(session)) == 0
    assert any("VTI" in w for w in result.warnings)


def test_stock_buy_multi_lot_merged(session: Session) -> None:
    config = _base_accounts(session)
    vsgx_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:VSGX")
    config["stock_accounts"]["VSGX"] = vsgx_stock

    xml = _flex_xml(
        trades="""
        <Trade accountId="U12345" currency="USD" symbol="VSGX" assetCategory="STK"
          buySell="BUY" quantity="14" tradePrice="68.03" tradeMoney="-952.42"
          ibCommission="-1.000308" ibCommissionCurrency="USD"
          transactionID="TX010" ibOrderID="ORD010"
          tradeDate="2024-01-15" reportDate="2024-01-15"
          cost="-952.42" fifoPnlRealized="0" />
        <Trade accountId="U12345" currency="USD" symbol="VSGX" assetCategory="STK"
          buySell="BUY" quantity="86" tradePrice="68.03" tradeMoney="-5850.58"
          ibCommission="-0.001892" ibCommissionCurrency="USD"
          transactionID="TX011" ibOrderID="ORD010"
          tradeDate="2024-01-15" reportDate="2024-01-15"
          cost="-5850.58" fifoPnlRealized="0" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    # Two partial fills with same orderID → one merged transaction
    assert len(txs) == 1
    tx = txs[0]
    assert tx.narration == "Buying VSGX"
    assert tx.source_native_id == "ibkr:order:ORD010"

    vsgx_postings = [p for p in tx.postings if p.units_symbol == "VSGX"]
    assert len(vsgx_postings) == 2
    qtys = sorted(p.units_amount for p in vsgx_postings)
    assert qtys == [Decimal("14"), Decimal("86")]

    usd_postings = [
        p for p in tx.postings if p.account.account_name == "Assets:Liquid:IBKR:Depot:USD"
    ]
    # One posting is the stock cash debit (sum of tradeMoney), one is the commission debit
    cash_debit = next(p for p in usd_postings if p.units_amount == Decimal("-6803.00"))
    assert cash_debit is not None


# ---------------------------------------------------------------------------
# Stock sell
# ---------------------------------------------------------------------------


def test_stock_sell_single_lot(session: Session) -> None:
    config = _base_accounts(session)
    vti_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:VTI")
    config["stock_accounts"]["VTI"] = vti_stock

    xml = _flex_xml(
        trades="""
        <Trade accountId="U12345" currency="USD" symbol="VTI" assetCategory="STK"
          buySell="SELL" quantity="-33" tradePrice="177.69" tradeMoney="5863.77"
          ibCommission="-1.13" ibCommissionCurrency="USD"
          transactionID="TX002" ibOrderID="ORD002"
          tradeDate="2024-01-20" reportDate="2024-01-20"
          cost="-4819.98" fifoPnlRealized="1042.66" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    tx = txs[0]
    assert tx.narration == "Selling VTI"
    assert tx.source_native_id == "ibkr:order:ORD002"

    posting_map = {p.account.account_name: p for p in tx.postings}
    vti_posting = posting_map["Assets:SemiLiquid:Shares:IBKR:VTI"]
    assert vti_posting.units_amount == Decimal("-33")
    assert vti_posting.cost_per_unit is not None
    assert vti_posting.price_per_unit == Decimal("177.69")

    usd_postings = [
        p for p in tx.postings if p.account.account_name == "Assets:Liquid:IBKR:Depot:USD"
    ]
    assert any(p.units_amount == Decimal("5863.77") for p in usd_postings)
    assert any(p.units_amount == Decimal("-1.13") for p in usd_postings)

    assert "Income:ProfitLoss:IBKR" in posting_map


def test_stock_sell_multi_lot_merged(session: Session) -> None:
    config = _base_accounts(session)
    bnd_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:BND")
    config["stock_accounts"]["BND"] = bnd_stock

    xml = _flex_xml(
        trades="""
        <Trade accountId="U12345" currency="USD" symbol="BND" assetCategory="STK"
          buySell="SELL" quantity="-60" tradePrice="72.14" tradeMoney="4328.40"
          ibCommission="-0.61" ibCommissionCurrency="USD"
          transactionID="TX003" ibOrderID="ORD003"
          tradeDate="2024-01-22" reportDate="2024-01-22"
          cost="-5107.80" fifoPnlRealized="-780.01" />
        <Trade accountId="U12345" currency="USD" symbol="BND" assetCategory="STK"
          buySell="SELL" quantity="-40" tradePrice="72.14" tradeMoney="2885.60"
          ibCommission="-0.61" ibCommissionCurrency="USD"
          transactionID="TX004" ibOrderID="ORD003"
          tradeDate="2024-01-22" reportDate="2024-01-22"
          cost="-3395.60" fifoPnlRealized="-510.61" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    # Two trades with same orderID → one merged transaction
    assert len(txs) == 1
    tx = txs[0]
    assert tx.source_native_id == "ibkr:order:ORD003"

    bnd_postings = [
        p for p in tx.postings if p.account.account_name == "Assets:SemiLiquid:Shares:IBKR:BND"
    ]
    assert len(bnd_postings) == 2
    qtys = sorted(p.units_amount for p in bnd_postings)
    assert qtys == [Decimal("-60"), Decimal("-40")]


# ---------------------------------------------------------------------------
# Forex conversions
# ---------------------------------------------------------------------------


def test_forex_buy_usd_with_chf(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        trades="""
        <Trade accountId="U12345" currency="CHF" symbol="USD.CHF" assetCategory="CASH"
          buySell="BUY" quantity="5000" tradePrice="1.02056" tradeMoney="-5102.80"
          ibCommission="-2.04" ibCommissionCurrency="CHF"
          transactionID="FX001" ibOrderID="FX001"
          tradeDate="2024-01-15" reportDate="2024-01-15"
          cost="0" fifoPnlRealized="0" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    tx = txs[0]
    assert tx.narration == "Bought some USD"
    assert tx.source_native_id == "ibkr:FX001"

    usd_posting = next(p for p in tx.postings if p.units_symbol == "USD")
    assert usd_posting.units_amount == Decimal("5000")
    assert usd_posting.price_per_unit == Decimal("1.02056")
    assert usd_posting.price_symbol == "CHF"

    chf_postings = [p for p in tx.postings if p.units_symbol == "CHF"]
    cash_chf = next(
        p
        for p in chf_postings
        if p.units_amount < 0 and p.account.account_name == "Assets:Liquid:IBKR:Depot:CHF"
    )
    assert cash_chf.units_amount == Decimal("-5102.80")


def test_forex_sell_usd_for_chf(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        trades="""
        <Trade accountId="U12345" currency="CHF" symbol="USD.CHF" assetCategory="CASH"
          buySell="SELL" quantity="-5000" tradePrice="0.931" tradeMoney="4655.00"
          ibCommission="-1.86" ibCommissionCurrency="CHF"
          transactionID="FX002" ibOrderID="FX002"
          tradeDate="2024-01-20" reportDate="2024-01-20"
          cost="0" fifoPnlRealized="0" />
        """,
    )

    _run(session, xml, config)
    txs = _transactions(session)
    assert len(txs) == 1
    tx = txs[0]
    assert tx.narration == "Sold some USD"

    usd_posting = next(p for p in tx.postings if p.units_symbol == "USD")
    assert usd_posting.units_amount == Decimal("-5000")


# ---------------------------------------------------------------------------
# Balance assertions
# ---------------------------------------------------------------------------


def test_balance_assertions_cash(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        cash_report="""
        <CashReportCurrency currency="USD" endingCash="12345.67" />
        <CashReportCurrency currency="CHF" endingCash="5000.00" />
        """,
    )

    _run(session, xml, config)
    assertions = _balance_assertions(session)
    assert len(assertions) == 2

    by_symbol = {a.symbol: a for a in assertions}
    assert by_symbol["USD"].amount == Decimal("12345.67")
    assert by_symbol["USD"].assertion_date == date(2024, 2, 1)
    assert by_symbol["CHF"].amount == Decimal("5000.00")


def test_balance_assertions_stock_open_positions(session: Session) -> None:
    config = _base_accounts(session)
    vti_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:VTI")
    config["stock_accounts"]["VTI"] = vti_stock

    xml = _flex_xml(
        open_positions="""
        <OpenPosition symbol="VTI" currency="USD" position="100" markPrice="220.50"
          reportDate="2024-01-31" />
        """,
    )

    _run(session, xml, config)
    assertions = _balance_assertions(session)
    vti_assertions = [a for a in assertions if a.symbol == "VTI"]
    assert len(vti_assertions) == 1
    assert vti_assertions[0].amount == Decimal("100")
    assert vti_assertions[0].assertion_date == date(2024, 2, 1)


def test_balance_assertions_zero_position_for_configured_absent_stocks(session: Session) -> None:
    config = _base_accounts(session)
    vti_stock = _create_account(session, "Assets:SemiLiquid:Shares:IBKR:VTI")
    config["stock_accounts"]["VTI"] = vti_stock

    # VTI not in open positions → zero assertion
    xml = _flex_xml(open_positions="")

    _run(session, xml, config)
    assertions = _balance_assertions(session)
    vti_assertions = [a for a in assertions if a.symbol == "VTI"]
    assert len(vti_assertions) == 1
    assert vti_assertions[0].amount == Decimal("0")


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------


def test_deduplication_on_reimport(session: Session) -> None:
    config = _base_accounts(session)

    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="USD" symbol=""
          type="Broker Interest Received" amount="5.00" reportDate="2024-01-31"
          transactionID="INT001" description="USD Interest" />
        """,
    )

    result1 = _run(session, xml, config)
    result2 = _run(session, xml, config)

    assert result1.entities["transaction"].created == 1
    assert result2.entities["transaction"].duplicate == 1
    assert len(_transactions(session)) == 1


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


def test_missing_token_raises(session: Session) -> None:
    config = _base_accounts(session)
    config.pop("token")

    def fake_fetch(token: str, query_id: str) -> bytes:
        return _flex_xml()

    with patch.object(ibkr_importer, "_fetch_flex_xml", side_effect=fake_fetch):
        with pytest.raises(ValidationError, match="token"):
            ibkr_importer.IbkrImporter().execute(ImportContext(session), {}, config)


def test_missing_required_account_raises(session: Session) -> None:
    config = _base_accounts(session)
    config.pop("commissions_account")

    xml = _flex_xml()

    with patch.object(ibkr_importer, "_fetch_flex_xml", return_value=xml):
        with pytest.raises(ValidationError, match="commissions_account"):
            ibkr_importer.IbkrImporter().execute(ImportContext(session), {}, config)


def test_missing_cash_currency_mapping_raises(session: Session) -> None:
    config = _base_accounts(session)
    # Statement has EUR transactions but no EUR cash account configured
    xml = _flex_xml(
        cash_transactions="""
        <CashTransaction accountId="U12345" currency="EUR" symbol=""
          type="Deposits &amp; Withdrawals" amount="1000.00" reportDate="2024-01-05"
          transactionID="DEP001" description="EUR Transfer" />
        """,
    )

    with patch.object(ibkr_importer, "_fetch_flex_xml", return_value=xml):
        with pytest.raises(ValidationError, match="EUR"):
            ibkr_importer.IbkrImporter().execute(ImportContext(session), {}, config)
