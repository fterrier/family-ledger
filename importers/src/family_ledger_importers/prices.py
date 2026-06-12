from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import requests
from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import MoneyValue, PriceCreate
from family_ledger.config import Settings, get_ledger_config
from family_ledger.importers.base import BaseImporter, ImportContext, ImportResult
from family_ledger.models import Commodity, Posting
from family_ledger.services.errors import ValidationError

_YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
_LOOKBACK_DAYS = 7


def _to_unix(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def fetch_yahoo_close(ticker: str, target_date: date) -> tuple[Decimal, str] | None:
    """Fetch the latest closing price on or before target_date from Yahoo Finance.

    Looks back up to _LOOKBACK_DAYS to handle weekends and market holidays.
    Returns (price, quote_currency) or None if no data is available in the window.
    Raises ValidationError on HTTP or API errors.
    """
    period1 = _to_unix(target_date - timedelta(days=_LOOKBACK_DAYS))
    period2 = _to_unix(target_date + timedelta(days=1))

    url = _YAHOO_CHART_URL.format(ticker=ticker)
    params = {"interval": "1d", "period1": period1, "period2": period2, "events": "history"}
    headers = {"User-Agent": "family-ledger/1.0"}

    try:
        resp = requests.get(url, params=params, headers=headers, timeout=15)
        resp.raise_for_status()
    except requests.HTTPError as exc:
        raise ValidationError(
            code="yahoo_http_error",
            message=f"Yahoo Finance HTTP error for {ticker!r}: {exc}",
        ) from exc
    except requests.RequestException as exc:
        raise ValidationError(
            code="yahoo_request_error",
            message=f"Yahoo Finance request failed for {ticker!r}: {exc}",
        ) from exc

    try:
        data = resp.json()
        result = data["chart"]["result"][0]
        api_currency: str = result["meta"]["currency"]
        timestamps: list[int] = result["timestamp"]
        closes: list[float | None] = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError):
        return None

    best: Decimal | None = None
    for ts, close in zip(timestamps, closes, strict=False):
        if ts < period2 and close is not None:
            best = Decimal(str(close))

    if best is None:
        return None
    return best, api_currency


def _resolve_ticker(base: str, quote: str, commodity_ticker: str | None, *, is_forex: bool) -> str:
    """Determine the Yahoo Finance ticker for a (base, quote) pair.

    Priority:
    1. Commodity.ticker — explicit override set on the commodity
    2. is_forex=True (pair discovered from uncost currency postings) → "{base}{quote}=X"
    3. Fallback: use base as the equity ticker
    """
    if commodity_ticker:
        return commodity_ticker
    if is_forex:
        return f"{base}{quote}=X"
    return base


def discover_price_pairs(session: Session, base_currency: str) -> list[tuple[str, str, bool]]:
    """Return sorted unique (base_symbol, quote_symbol, is_forex) triples inferred from postings.

    Mirrors beancount bean-price discovery:
    - Postings with cost_symbol → equity pairs: (units_symbol, cost_symbol, False)
    - Postings with price_symbol → direct pairs: (units_symbol, price_symbol, False)
    - Postings without cost/price, not base_currency → (units_symbol, base_currency, True)
      (only when not already found as an equity base)
    """
    equity_pairs: set[tuple[str, str]] = set()

    for row in session.execute(
        select(Posting.units_symbol, Posting.cost_symbol)
        .where(Posting.cost_symbol.is_not(None), Posting.units_symbol != base_currency)
        .distinct()
    ):
        equity_pairs.add((row.units_symbol, row.cost_symbol))

    for row in session.execute(
        select(Posting.units_symbol, Posting.price_symbol)
        .where(Posting.price_symbol.is_not(None), Posting.units_symbol != base_currency)
        .distinct()
    ):
        equity_pairs.add((row.units_symbol, row.price_symbol))

    equity_bases = {base for base, _ in equity_pairs}

    forex_pairs: set[tuple[str, str]] = set()
    for sym in session.scalars(
        select(Posting.units_symbol)
        .where(Posting.cost_symbol.is_(None), Posting.units_symbol != base_currency)
        .distinct()
    ):
        if sym not in equity_bases:
            forex_pairs.add((sym, base_currency))

    result: list[tuple[str, str, bool]] = [(base, quote, False) for base, quote in equity_pairs] + [
        (base, quote, True) for base, quote in forex_pairs
    ]
    return sorted(result)


class PriceImporter(BaseImporter):
    name = "prices"
    display_name = "Yahoo Finance Price Importer"

    def get_file_descriptors(self) -> list[dict[str, Any]]:
        return []

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "required": ["date"],
            "properties": {
                "date": {
                    "type": "string",
                    "format": "date",
                    "description": (
                        "Date to fetch prices for (YYYY-MM-DD). "
                        "Falls back to the prior trading day for weekends and holidays."
                    ),
                },
                "base_currency": {
                    "type": "string",
                    "description": (
                        "Home currency for forex pairs. Defaults to the ledger default_currency."
                    ),
                },
            },
            "additionalProperties": False,
        }

    def execute(
        self,
        ctx: ImportContext,
        files: dict[str, bytes],
        config: dict[str, Any],
        settings: Settings | None = None,
    ) -> ImportResult:
        raw_date = config.get("date")
        if raw_date is None:
            raise ValidationError(code="missing_date", message="config.date is required")
        try:
            target_date = date.fromisoformat(str(raw_date))
        except ValueError as exc:
            raise ValidationError(
                code="invalid_date",
                message=f"config.date must be YYYY-MM-DD, got: {raw_date!r}",
            ) from exc

        raw_base = config.get("base_currency")
        base_currency: str = str(raw_base) if raw_base else get_ledger_config().default_currency

        pairs = discover_price_pairs(ctx.session, base_currency)

        base_symbols = {base for base, _, _is_forex in pairs}
        commodities_by_symbol: dict[str, tuple[str | None, dict[str, Any]]] = {
            sym: (ticker, meta)
            for sym, ticker, meta in ctx.session.execute(
                select(Commodity.symbol, Commodity.ticker, Commodity.entity_metadata).where(
                    Commodity.symbol.in_(base_symbols)
                )
            )
        }

        for base_symbol, quote_symbol, is_forex in pairs:
            commodity_ticker, commodity_meta = commodities_by_symbol.get(base_symbol, (None, {}))
            ticker = _resolve_ticker(base_symbol, quote_symbol, commodity_ticker, is_forex=is_forex)

            try:
                result = fetch_yahoo_close(ticker, target_date)
            except ValidationError as exc:
                ctx.add_warning(
                    f"Failed to fetch price for {base_symbol!r} (ticker: {ticker!r}): {exc.message}"
                )
                continue

            if result is None:
                ctx.add_warning(
                    f"No price data for {base_symbol!r} (ticker: {ticker!r})"
                    f" on or before {target_date}"
                )
                continue

            price_amount, api_currency = result

            yahoo_quote = commodity_meta.get("yahoo_quote")
            actual_quote: str = (
                str(yahoo_quote).upper()
                if isinstance(yahoo_quote, str) and yahoo_quote
                else api_currency.upper()
            )

            ctx.ensure_commodity(base_symbol)
            ctx.ensure_commodity(actual_quote)
            ctx.create_price(
                PriceCreate(
                    price_date=target_date,
                    base_symbol=base_symbol,
                    quote=MoneyValue(amount=price_amount, symbol=actual_quote),
                )
            )

        return ctx.result
