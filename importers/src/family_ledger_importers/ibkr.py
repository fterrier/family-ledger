from __future__ import annotations

import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from ibflex import Types, enums, parser

from family_ledger.api.schemas import (
    BalanceAssertionCreate,
    ImportMetadata,
    MoneyValue,
    PostingNormalizePayload,
    TransactionNormalizeData,
)
from family_ledger.importers.base import BaseImporter, ImportContext, ImportResult
from family_ledger.services.errors import ValidationError

_FLEX_BASE_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
_FETCH_MAX_RETRIES = 15
_FETCH_RETRY_DELAY_SECONDS = 2
_CASH_BALANCE_PRECISION = Decimal("0.01")


@dataclass(frozen=True)
class _ResolvedAccounts:
    cash: dict[str, str]
    stocks: dict[str, str]
    dividends: dict[str, str]
    commissions: str
    fees: str
    profit_loss: str
    interest: str
    withholding_tax: str


def _fetch_flex_xml(token: str, query_id: str) -> bytes:
    headers = {"User-Agent": "family-ledger/1.0"}
    send_url = f"{_FLEX_BASE_URL}/SendRequest?t={token}&q={query_id}&v=3"
    req = urllib.request.Request(send_url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        send_response = resp.read()

    root = ET.fromstring(send_response)
    status = root.findtext("Status") or ""
    if status != "Success":
        error_msg = root.findtext("ErrorMessage") or root.findtext("Message") or status
        raise ValidationError(
            code="ibkr_api_error", message=f"IBKR SendRequest failed: {error_msg}"
        )

    reference_code = (root.findtext("ReferenceCode") or "").strip()
    if not reference_code:
        raise ValidationError(
            code="ibkr_api_error", message="IBKR SendRequest returned no ReferenceCode"
        )

    get_url = f"{_FLEX_BASE_URL}/GetStatement?t={token}&q={reference_code}&v=3"
    for attempt in range(_FETCH_MAX_RETRIES):
        req = urllib.request.Request(get_url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            statement_data = resp.read()
        get_root = ET.fromstring(statement_data)
        get_status = get_root.findtext("Status") or ""
        if get_status == "Processing" or (not get_root.findall("FlexStatements") and get_status):
            if attempt < _FETCH_MAX_RETRIES - 1:
                time.sleep(_FETCH_RETRY_DELAY_SECONDS)
                continue
        else:
            return statement_data
    raise ValidationError(
        code="ibkr_api_timeout", message="IBKR GetStatement timed out waiting for report"
    )


def _parse_flex_statement(xml_data: bytes) -> Types.FlexStatement:
    response: Types.FlexQueryResponse = parser.parse(xml_data)
    statements = response.FlexStatements
    if not statements:
        raise ValidationError(
            code="ibkr_parse_error", message="No FlexStatements found in IBKR response"
        )
    return statements[0]


def _collect_required_account(
    errors: list[str], account_key: str, resource_name: str | None, known_accounts: set[str]
) -> str:
    if not resource_name or not isinstance(resource_name, str):
        errors.append(f"missing required account config: {account_key}")
        return ""
    if resource_name not in known_accounts:
        errors.append(f"account not found: {resource_name!r} (for {account_key})")
        return ""
    return resource_name


def _resolve_accounts(
    ctx: ImportContext,
    config: dict[str, Any],
    statement: Types.FlexStatement,
) -> tuple[_ResolvedAccounts, list[str]]:
    known_accounts = ctx.load_account_names()
    errors: list[str] = []
    warnings: list[str] = []

    raw_cash = config.get("cash_accounts") or {}
    raw_stocks = config.get("stock_accounts") or {}
    raw_dividends = config.get("dividend_accounts") or {}

    cash_accounts: dict[str, str] = {}
    for currency, resource_name in raw_cash.items():
        if resource_name not in known_accounts:
            errors.append(f"cash account not found: {resource_name!r} (for currency {currency})")
        else:
            cash_accounts[currency.upper()] = resource_name

    stock_accounts: dict[str, str] = {}
    for symbol, resource_name in raw_stocks.items():
        if resource_name not in known_accounts:
            errors.append(f"stock account not found: {resource_name!r} (for symbol {symbol})")
        else:
            stock_accounts[symbol.upper()] = resource_name

    dividend_accounts: dict[str, str] = {}
    for symbol, resource_name in raw_dividends.items():
        if resource_name not in known_accounts:
            errors.append(f"dividend account not found: {resource_name!r} (for symbol {symbol})")
        else:
            dividend_accounts[symbol.upper()] = resource_name

    # Validate currency coverage for all CashTransactions
    missing_currencies: set[str] = set()
    if statement.CashTransactions:
        for tx in statement.CashTransactions:
            currency = (tx.currency or "").upper()
            if currency and currency not in cash_accounts and currency not in missing_currencies:
                errors.append(f"missing cash_accounts mapping for currency: {currency}")
                missing_currencies.add(currency)

    commissions = _collect_required_account(
        errors, "commissions_account", config.get("commissions_account"), known_accounts
    )
    fees = _collect_required_account(
        errors, "fees_account", config.get("fees_account"), known_accounts
    )
    profit_loss = _collect_required_account(
        errors, "profit_loss_account", config.get("profit_loss_account"), known_accounts
    )
    interest = _collect_required_account(
        errors, "interest_account", config.get("interest_account"), known_accounts
    )
    withholding_tax = _collect_required_account(
        errors, "withholding_tax_account", config.get("withholding_tax_account"), known_accounts
    )

    if errors:
        raise ValidationError(
            code="account_not_found",
            message="IBKR importer account errors:\n" + "\n".join(f"  • {e}" for e in errors),
        )

    # Warn on missing symbol mappings (don't fail)
    all_symbols: set[str] = set()
    if statement.Trades:
        for trade in statement.Trades:
            if trade.assetCategory == enums.AssetClass.STOCK and trade.symbol:
                all_symbols.add(trade.symbol.upper())
    if statement.CashTransactions:
        for tx in statement.CashTransactions:
            if tx.type == enums.CashAction.DIVIDEND and tx.symbol:
                all_symbols.add(tx.symbol.upper())

    for symbol in sorted(all_symbols):
        if symbol not in stock_accounts:
            warnings.append(
                f"No stock_accounts mapping for symbol {symbol!r}"
                " — transactions skipped. Add it and re-import."
            )
        if symbol not in dividend_accounts:
            warnings.append(
                f"No dividend_accounts mapping for symbol {symbol!r}"
                " — dividend transactions skipped. Add it and re-import."
            )

    resolved = _ResolvedAccounts(
        cash=cash_accounts,
        stocks=stock_accounts,
        dividends=dividend_accounts,
        commissions=commissions,
        fees=fees,
        profit_loss=profit_loss,
        interest=interest,
        withholding_tax=withholding_tax,
    )
    return resolved, warnings


def _coerce_date(value: date | datetime | None) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    return value


def _tx_date(tx: Types.CashTransaction) -> date:
    d = _coerce_date(tx.reportDate or tx.dateTime)
    if d is None:
        raise ValidationError(code="ibkr_parse_error", message=f"CashTransaction has no date: {tx}")
    return d


def _trade_date(trade: Types.Trade) -> date:
    d = _coerce_date(trade.tradeDate or trade.reportDate)
    if d is None:
        raise ValidationError(code="ibkr_parse_error", message=f"Trade has no date: {trade}")
    return d


# ---------------------------------------------------------------------------
# Dividend + withholding grouping
# ---------------------------------------------------------------------------


@dataclass
class _DividendGroup:
    dividend: Types.CashTransaction | None = None
    withholdings: list[Types.CashTransaction] = field(default_factory=list)


def _group_dividend_transactions(
    cash_txs: tuple[Types.CashTransaction, ...],
) -> dict[tuple[date, str], _DividendGroup]:
    groups: dict[tuple[date, str], _DividendGroup] = defaultdict(_DividendGroup)
    for tx in cash_txs:
        if tx.type not in (enums.CashAction.DIVIDEND, enums.CashAction.WHTAX):
            continue
        symbol = (tx.symbol or "").upper()
        if not symbol:
            continue
        key = (_tx_date(tx), symbol)
        if tx.type == enums.CashAction.DIVIDEND:
            groups[key].dividend = tx
        else:
            groups[key].withholdings.append(tx)
    return groups


def _build_dividend_transaction(
    group: _DividendGroup,
    accounts: _ResolvedAccounts,
) -> TransactionNormalizeData | None:
    div_tx = group.dividend
    wh_txs = group.withholdings

    if div_tx is None and not wh_txs:
        return None

    primary_tx = div_tx if div_tx is not None else wh_txs[0]

    symbol = (primary_tx.symbol or "").upper()
    has_dividend_account = symbol in accounts.dividends

    if div_tx is not None and not has_dividend_account:
        return None

    tx_date = _tx_date(primary_tx)
    currency = (primary_tx.currency or "").upper()
    cash_account = accounts.cash[currency]

    postings: list[PostingNormalizePayload] = []

    if div_tx is not None:
        div_amount = div_tx.amount or Decimal(0)
        postings.append(
            PostingNormalizePayload(
                account=cash_account,
                units=MoneyValue(amount=div_amount, symbol=currency),
            )
        )

    if wh_txs:
        # Sum all withholding entries (handles year-end multi-correction batches)
        wh_currency = (wh_txs[0].currency or currency).upper()
        total_wh = sum((tx.amount or Decimal(0) for tx in wh_txs), Decimal(0))
        postings.append(
            PostingNormalizePayload(
                account=cash_account,
                units=MoneyValue(amount=total_wh, symbol=wh_currency),
                narration="Withholding tax",
            )
        )
        postings.append(
            PostingNormalizePayload(
                account=accounts.withholding_tax,
                units=MoneyValue(amount=-total_wh, symbol=wh_currency),
                narration="Withholding tax",
            )
        )

    if has_dividend_account:
        postings.append(
            PostingNormalizePayload(
                account=accounts.dividends[symbol],
                units=None,
            )
        )

    meta: dict[str, Any] = {"symbol": symbol, "currency": currency}
    if div_tx is not None:
        meta["dividend_transaction_id"] = div_tx.transactionID
    if wh_txs:
        meta["withholding_transaction_ids"] = [tx.transactionID for tx in wh_txs]

    source_native_id = f"ibkr:{primary_tx.transactionID}"

    description = (primary_tx.description or "").strip()

    return TransactionNormalizeData(
        transaction_date=tx_date,
        payee=None,
        narration=description or f"Dividends {symbol}",
        entity_metadata={"ibkr": meta},
        import_metadata=ImportMetadata(source_native_ids=[source_native_id]),
        postings=postings,
    )


# ---------------------------------------------------------------------------
# Interest, fees, deposits/withdrawals
# ---------------------------------------------------------------------------


def _build_cash_transaction(
    tx: Types.CashTransaction,
    accounts: _ResolvedAccounts,
) -> TransactionNormalizeData | None:
    currency = (tx.currency or "").upper()
    if currency not in accounts.cash:
        return None

    amount = tx.amount or Decimal(0)
    cash_account = accounts.cash[currency]
    description = (tx.description or "").strip()
    tx_date = _tx_date(tx)

    if tx.type in (enums.CashAction.BROKERINTRCVD, enums.CashAction.BONDINTRCVD):
        counterpart = accounts.interest
        narration = description or f"{currency} Interest"
        meta_key = "interest"
    elif tx.type == enums.CashAction.FEES:
        counterpart = accounts.fees
        narration = description or "IBKR Fee"
        meta_key = "fee"
    elif tx.type == enums.CashAction.DEPOSITWITHDRAW:
        return TransactionNormalizeData(
            transaction_date=tx_date,
            payee=None,
            narration=description or "Transfer",
            entity_metadata={"ibkr": {"transfer": True, "transaction_id": tx.transactionID}},
            import_metadata=ImportMetadata(source_native_ids=[f"ibkr:{tx.transactionID}"]),
            postings=[
                PostingNormalizePayload(
                    account=cash_account,
                    units=MoneyValue(amount=amount, symbol=currency),
                ),
            ],
        )
    else:
        return None

    return TransactionNormalizeData(
        transaction_date=tx_date,
        payee=None,
        narration=narration,
        entity_metadata={"ibkr": {meta_key: True, "transaction_id": tx.transactionID}},
        import_metadata=ImportMetadata(source_native_ids=[f"ibkr:{tx.transactionID}"]),
        postings=[
            PostingNormalizePayload(
                account=cash_account,
                units=MoneyValue(amount=amount, symbol=currency),
            ),
            PostingNormalizePayload(
                account=counterpart,
                units=None,
            ),
        ],
    )


# ---------------------------------------------------------------------------
# Stock trades
# ---------------------------------------------------------------------------


def _build_stock_buy_group(
    trades: list[Types.Trade],
    accounts: _ResolvedAccounts,
) -> TransactionNormalizeData | None:
    if not trades:
        return None

    first = trades[0]
    symbol = (first.symbol or "").upper()
    if symbol not in accounts.stocks:
        return None

    currency = (first.currency or "").upper()
    if currency not in accounts.cash:
        return None

    trade_date = _trade_date(first)
    order_id = first.ibOrderID

    total_cash = sum((abs(t.tradeMoney or Decimal(0)) for t in trades), Decimal(0))
    total_commission = sum((abs(t.ibCommission or Decimal(0)) for t in trades), Decimal(0))
    commission_currency = (first.ibCommissionCurrency or currency).upper()

    postings: list[PostingNormalizePayload] = [
        PostingNormalizePayload(
            account=accounts.cash[currency],
            units=MoneyValue(amount=-total_cash, symbol=currency),
        ),
        PostingNormalizePayload(
            account=accounts.cash.get(commission_currency, accounts.cash[currency]),
            units=MoneyValue(amount=-total_commission, symbol=commission_currency),
        ),
    ]

    for trade in trades:
        qty = trade.quantity or Decimal(0)
        trade_price = trade.tradePrice or Decimal(0)
        postings.append(
            PostingNormalizePayload(
                account=accounts.stocks[symbol],
                units=MoneyValue(amount=qty, symbol=symbol),
                cost=MoneyValue(amount=trade_price, symbol=currency),
            )
        )

    postings.append(
        PostingNormalizePayload(
            account=accounts.commissions,
            units=MoneyValue(amount=total_commission, symbol=commission_currency),
        )
    )

    source_native_id = f"ibkr:order:{order_id}" if order_id else f"ibkr:{first.transactionID}"

    return TransactionNormalizeData(
        transaction_date=trade_date,
        payee=None,
        narration=f"Buying {symbol}",
        entity_metadata={
            "ibkr": {
                "order_id": str(order_id) if order_id else None,
                "symbol": symbol,
                "transaction_ids": [t.transactionID for t in trades],
            }
        },
        import_metadata=ImportMetadata(source_native_ids=[source_native_id]),
        postings=postings,
    )


def _build_stock_sell_group(
    trades: list[Types.Trade],
    accounts: _ResolvedAccounts,
) -> TransactionNormalizeData | None:
    if not trades:
        return None

    first = trades[0]
    symbol = (first.symbol or "").upper()
    if symbol not in accounts.stocks:
        return None

    currency = (first.currency or "").upper()
    if currency not in accounts.cash:
        return None

    trade_date = _trade_date(first)
    order_id = first.ibOrderID

    total_proceeds = sum((abs(t.tradeMoney or Decimal(0)) for t in trades), Decimal(0))
    total_commission = sum((abs(t.ibCommission or Decimal(0)) for t in trades), Decimal(0))
    commission_currency = (first.ibCommissionCurrency or currency).upper()

    postings: list[PostingNormalizePayload] = [
        PostingNormalizePayload(
            account=accounts.cash[currency],
            units=MoneyValue(amount=total_proceeds, symbol=currency),
        ),
        PostingNormalizePayload(
            account=accounts.cash.get(commission_currency, accounts.cash[currency]),
            units=MoneyValue(amount=-total_commission, symbol=commission_currency),
        ),
    ]

    for trade in trades:
        qty = trade.quantity or Decimal(0)
        trade_price = trade.tradePrice or Decimal(0)
        lot_cost = abs(trade.cost or Decimal(0))
        lot_qty = abs(qty)
        cost_per_unit = (lot_cost / lot_qty) if lot_qty else Decimal(0)

        postings.append(
            PostingNormalizePayload(
                account=accounts.stocks[symbol],
                units=MoneyValue(amount=qty, symbol=symbol),
                cost=MoneyValue(amount=cost_per_unit, symbol=currency),
                price=MoneyValue(amount=trade_price, symbol=currency),
            )
        )

    postings.append(
        PostingNormalizePayload(
            account=accounts.commissions,
            units=MoneyValue(amount=total_commission, symbol=commission_currency),
        )
    )

    # Auto-balanced P&L posting
    postings.append(
        PostingNormalizePayload(
            account=accounts.profit_loss,
            units=None,
        )
    )

    source_native_id = f"ibkr:order:{order_id}" if order_id else f"ibkr:{first.transactionID}"

    return TransactionNormalizeData(
        transaction_date=trade_date,
        payee=None,
        narration=f"Selling {symbol}",
        entity_metadata={
            "ibkr": {
                "order_id": str(order_id) if order_id else None,
                "symbol": symbol,
                "transaction_ids": [t.transactionID for t in trades],
            }
        },
        import_metadata=ImportMetadata(source_native_ids=[source_native_id]),
        postings=postings,
    )


# ---------------------------------------------------------------------------
# Forex / currency conversion
# ---------------------------------------------------------------------------


def _build_forex_transaction(
    trade: Types.Trade,
    accounts: _ResolvedAccounts,
) -> TransactionNormalizeData | None:
    symbol = (trade.symbol or "").upper()
    if "." not in symbol:
        return None

    base_currency, quote_currency = symbol.split(".", 1)
    base_currency = base_currency.upper()
    quote_currency = quote_currency.upper()

    if base_currency not in accounts.cash or quote_currency not in accounts.cash:
        return None

    qty = trade.quantity or Decimal(0)
    trade_price = trade.tradePrice or Decimal(0)
    commission = abs(trade.ibCommission or Decimal(0))
    commission_currency = (trade.ibCommissionCurrency or quote_currency).upper()
    quote_amount = abs(trade.tradeMoney or (qty * trade_price))

    trade_date = _trade_date(trade)

    narration = f"Bought some {base_currency}" if qty > 0 else f"Sold some {base_currency}"
    base_posting = PostingNormalizePayload(
        account=accounts.cash[base_currency],
        units=MoneyValue(amount=qty, symbol=base_currency),
        price=MoneyValue(amount=trade_price, symbol=quote_currency),
    )
    quote_sign = -1 if qty > 0 else 1
    quote_posting = PostingNormalizePayload(
        account=accounts.cash[quote_currency],
        units=MoneyValue(amount=quote_sign * quote_amount, symbol=quote_currency),
    )

    postings: list[PostingNormalizePayload] = [base_posting, quote_posting]

    if commission > 0:
        comm_account = accounts.cash.get(commission_currency)
        if comm_account:
            postings.append(
                PostingNormalizePayload(
                    account=comm_account,
                    units=MoneyValue(amount=-commission, symbol=commission_currency),
                )
            )
            postings.append(
                PostingNormalizePayload(
                    account=accounts.commissions,
                    units=MoneyValue(amount=commission, symbol=commission_currency),
                )
            )

    return TransactionNormalizeData(
        transaction_date=trade_date,
        payee=None,
        narration=narration,
        entity_metadata={"ibkr": {"transaction_id": trade.transactionID, "forex": symbol}},
        import_metadata=ImportMetadata(source_native_ids=[f"ibkr:{trade.transactionID}"]),
        postings=postings,
    )


# ---------------------------------------------------------------------------
# Balance assertions
# ---------------------------------------------------------------------------


def _build_cash_balance_assertions(
    statement: Types.FlexStatement,
    accounts: _ResolvedAccounts,
    assertion_date: date,
) -> list[BalanceAssertionCreate]:
    assertions: list[BalanceAssertionCreate] = []
    if not statement.CashReport:
        return assertions

    for report in statement.CashReport:
        currency = (report.currency or "").upper()
        # Skip aggregate summary rows (e.g. BASE_SUMMARY)
        if currency not in accounts.cash or report.endingCash is None:
            continue
        assertions.append(
            BalanceAssertionCreate(
                assertion_date=assertion_date,
                account=accounts.cash[currency],
                amount=MoneyValue(
                    amount=report.endingCash.quantize(_CASH_BALANCE_PRECISION), symbol=currency
                ),
                entity_metadata={
                    "ibkr": {"currency": currency, "ending_cash": str(report.endingCash)}
                },
            )
        )
    return assertions


def _build_stock_balance_assertions(
    statement: Types.FlexStatement,
    accounts: _ResolvedAccounts,
    assertion_date: date,
) -> list[BalanceAssertionCreate]:
    assertions: list[BalanceAssertionCreate] = []
    open_positions = statement.OpenPositions or ()
    open_symbols: set[str] = set()

    # Aggregate per-lot rows into total position per symbol.
    # IBKR reports can include both Lot-level rows (one per tax lot) and a Symbol-level summary
    # row for the same position. Summing all would double-count; use only Lot rows when present.
    has_lot_rows = any((pos.levelOfDetail or "").upper() == "LOT" for pos in open_positions)
    aggregated: dict[str, Decimal] = defaultdict(Decimal)
    for pos in open_positions:
        symbol = (pos.symbol or "").upper()
        if has_lot_rows and (pos.levelOfDetail or "").upper() != "LOT":
            continue
        if symbol in accounts.stocks:
            aggregated[symbol] += pos.position or Decimal(0)

    for symbol, qty in aggregated.items():
        open_symbols.add(symbol)
        assertions.append(
            BalanceAssertionCreate(
                assertion_date=assertion_date,
                account=accounts.stocks[symbol],
                amount=MoneyValue(amount=qty, symbol=symbol),
                entity_metadata={"ibkr": {"symbol": symbol, "position": str(qty)}},
            )
        )

    # Assert zero for configured stocks not present in open positions
    for symbol, account in accounts.stocks.items():
        if symbol not in open_symbols:
            assertions.append(
                BalanceAssertionCreate(
                    assertion_date=assertion_date,
                    account=account,
                    amount=MoneyValue(amount=Decimal(0), symbol=symbol),
                    entity_metadata={"ibkr": {"symbol": symbol, "position": "0"}},
                )
            )

    return assertions


# ---------------------------------------------------------------------------
# Main importer class
# ---------------------------------------------------------------------------


class IbkrImporter(BaseImporter):
    name = "ibkr"
    display_name = "Interactive Brokers (Flex API)"

    def get_schema(self) -> dict[str, Any]:
        account_map_schema = {
            "type": "object",
            "additionalProperties": {"type": "string", "x-resource-type": "account"},
            "default": {},
        }
        single_account = {"type": "string", "x-resource-type": "account"}
        return {
            "type": "object",
            "properties": {
                "token": {
                    "type": "string",
                    "description": "IBKR Flex Web Service token.",
                },
                "query_id": {
                    "type": "string",
                    "description": "IBKR Flex Query ID.",
                },
                "cash_accounts": {
                    **account_map_schema,
                    "description": "Map currency code (USD, CHF, EUR) to cash depot account.",
                },
                "stock_accounts": {
                    **account_map_schema,
                    "description": "Map ticker symbol (VTI, VXUS) to stock account resource name.",
                },
                "dividend_accounts": {
                    **account_map_schema,
                    "description": "Map ticker symbol (VTI, VXUS) to dividend income account.",
                },
                "commissions_account": {
                    **single_account,
                    "description": "Account for trading commissions.",
                },
                "fees_account": {
                    **single_account,
                    "description": "Account for IBKR account fees.",
                },
                "profit_loss_account": {
                    **single_account,
                    "description": "Account for realized capital gains/losses.",
                },
                "interest_account": {
                    **single_account,
                    "description": "Account for cash interest income.",
                },
                "withholding_tax_account": {
                    **single_account,
                    "description": "Account for US withholding taxes on dividends.",
                },
            },
            "additionalProperties": False,
        }

    def get_file_descriptors(self) -> list[dict[str, Any]]:
        return []

    def execute(
        self,
        ctx: ImportContext,
        files: dict[str, bytes],
        config: dict[str, Any],
        settings: object = None,
    ) -> ImportResult:
        token = str(config.get("token") or "").strip()
        query_id = str(config.get("query_id") or "").strip()
        if not token or not query_id:
            raise ValidationError(
                code="invalid_config",
                message="IBKR importer requires 'token' and 'query_id' in config",
            )

        xml_data = _fetch_flex_xml(token, query_id)
        statement = _parse_flex_statement(xml_data)

        accounts, warnings = _resolve_accounts(ctx, config, statement)
        for w in warnings:
            ctx.add_warning(w)

        # Ensure commodity records exist for all currencies and stock symbols
        symbols_seen: set[str] = set()
        for currency in accounts.cash:
            symbols_seen.add(currency)
        for symbol in accounts.stocks:
            symbols_seen.add(symbol)
        if statement.OpenPositions:
            for pos in statement.OpenPositions:
                if pos.symbol:
                    symbols_seen.add(pos.symbol.upper())

        for symbol in sorted(symbols_seen):
            ctx.ensure_commodity(symbol)

        # --- Cash transactions ---
        cash_txs = statement.CashTransactions or ()

        dividend_groups = _group_dividend_transactions(cash_txs)
        for group in dividend_groups.values():
            payload = _build_dividend_transaction(group, accounts)
            if payload is not None:
                ctx.create_transaction(payload)

        for tx in cash_txs:
            if tx.type in (
                enums.CashAction.BROKERINTRCVD,
                enums.CashAction.BONDINTRCVD,
                enums.CashAction.FEES,
                enums.CashAction.DEPOSITWITHDRAW,
            ):
                payload = _build_cash_transaction(tx, accounts)
                if payload is not None:
                    ctx.create_transaction(payload)

        # --- Trades ---
        trades = statement.Trades or ()

        buy_groups: dict[str, list[Types.Trade]] = defaultdict(list)
        sell_groups: dict[str, list[Types.Trade]] = defaultdict(list)

        for trade in trades:
            # Skip IBKR aggregate/summary rows that have no transactionID
            if not trade.transactionID:
                continue
            if trade.assetCategory == enums.AssetClass.STOCK:
                group_key = str(trade.ibOrderID) if trade.ibOrderID else str(trade.transactionID)
                if trade.buySell == enums.BuySell.BUY:
                    buy_groups[group_key].append(trade)
                elif trade.buySell == enums.BuySell.SELL:
                    sell_groups[group_key].append(trade)
            elif trade.assetCategory == enums.AssetClass.CASH:
                payload = _build_forex_transaction(trade, accounts)
                if payload is not None:
                    ctx.create_transaction(payload)

        for buy_trade_list in buy_groups.values():
            payload = _build_stock_buy_group(buy_trade_list, accounts)
            if payload is not None:
                ctx.create_transaction(payload)

        for sell_trade_list in sell_groups.values():
            payload = _build_stock_sell_group(sell_trade_list, accounts)
            if payload is not None:
                ctx.create_transaction(payload)

        # --- Balance assertions ---
        to_date = _coerce_date(statement.toDate)
        if to_date is None:
            raise ValidationError(
                code="ibkr_parse_error",
                message="FlexStatement has no toDate for balance assertions",
            )
        assertion_date = to_date + timedelta(days=1)

        for payload in _build_cash_balance_assertions(statement, accounts, assertion_date):
            ctx.create_balance_assertion(payload)

        for payload in _build_stock_balance_assertions(statement, accounts, assertion_date):
            ctx.create_balance_assertion(payload)

        return ctx.result
