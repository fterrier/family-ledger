from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session

from family_ledger.importers.base import ImportContext, ImportResult
from family_ledger.models import Base, Price
from family_ledger.services.errors import ValidationError

# ---------------------------------------------------------------------------
# Beancount seed fixtures
# ---------------------------------------------------------------------------

_EQUITY_SEED = """
option "operating_currency" "CHF"

2020-01-01 open Assets:Broker:NESN NESN
2020-01-01 open Assets:Cash:CHF
2020-01-01 open Equity:Opening-Balances
2020-01-01 commodity CHF
2020-01-01 commodity NESN

2026-04-01 * "Buy NESN"
  Assets:Broker:NESN      10 NESN {100.00 CHF}
  Assets:Cash:CHF       -1000.00 CHF
"""

_FOREX_SEED = """
option "operating_currency" "CHF"

2020-01-01 open Assets:Cash:USD
2020-01-01 open Equity:Opening-Balances
2020-01-01 commodity CHF
2020-01-01 commodity USD

2026-04-01 * "USD deposit"
  Assets:Cash:USD         500 USD
  Equity:Opening-Balances
"""

_TICKER_META_SEED = """
option "operating_currency" "CHF"

2020-01-01 open Assets:Broker:NESN NESN
2020-01-01 open Assets:Cash:CHF
2020-01-01 open Equity:Opening-Balances
2020-01-01 commodity CHF
2020-01-01 commodity NESN
  ticker: "NESN.SW"

2026-04-01 * "Buy NESN"
  Assets:Broker:NESN      10 NESN {100.00 CHF}
  Assets:Cash:CHF       -1000.00 CHF
"""

_YAHOO_QUOTE_META_SEED = """
option "operating_currency" "CHF"

2020-01-01 open Assets:Broker:NESN NESN
2020-01-01 open Assets:Cash:CHF
2020-01-01 open Equity:Opening-Balances
2020-01-01 commodity CHF
2020-01-01 commodity NESN
  ticker: "NESN.SW"
  yahoo_quote: "CHF"

2026-04-01 * "Buy NESN"
  Assets:Broker:NESN      10 NESN {100.00 CHF}
  Assets:Cash:CHF       -1000.00 CHF
"""

# ---------------------------------------------------------------------------
# Fixtures
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


def _seed(session: Session, text: str) -> None:
    from family_ledger_importers.beancount import BeancountImporter

    BeancountImporter().execute(ImportContext(session), {"ledger_file": text.encode()}, {})


def _run_prices(session: Session, config: dict[str, Any]) -> ImportResult:
    from family_ledger_importers.prices import PriceImporter

    return PriceImporter().execute(ImportContext(session), {}, config)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_equity_pair_from_cost_annotation(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(session, _EQUITY_SEED)
    captured: list[str] = []

    def fake_fetch(ticker: str, d: date) -> tuple[Decimal, str] | None:
        captured.append(ticker)
        return Decimal("100.50"), "CHF"

    monkeypatch.setattr("family_ledger_importers.prices.fetch_yahoo_close", fake_fetch)
    result = _run_prices(session, {"date": "2026-06-11"})

    assert "NESN" in captured
    assert result.entities["price"].created == 1

    price = session.scalar(select(Price).where(Price.base_symbol == "NESN"))
    assert price is not None
    assert price.quote_symbol == "CHF"
    assert price.price_per_unit == Decimal("100.50")
    assert price.price_date == date(2026, 6, 11)


def test_three_letter_equity_ticker_not_treated_as_forex(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # SHV is a 3-letter ETF ticker held with USD cost — must NOT become "SHVUSD=X"
    seed = """
option "operating_currency" "CHF"

2020-01-01 open Assets:Broker:SHV SHV
2020-01-01 open Assets:Cash:USD USD
2020-01-01 open Equity:Opening-Balances
2020-01-01 commodity CHF
2020-01-01 commodity USD
2020-01-01 commodity SHV

2026-04-01 * "Buy SHV"
  Assets:Broker:SHV    10 SHV {110.00 USD}
  Assets:Cash:USD   -1100.00 USD
"""
    _seed(session, seed)
    captured: list[str] = []
    monkeypatch.setattr(
        "family_ledger_importers.prices.fetch_yahoo_close",
        lambda ticker, d: captured.append(ticker) or (Decimal("110.00"), "USD"),
    )
    _run_prices(session, {"date": "2026-06-11"})

    assert "SHV" in captured
    assert "SHVUSD=X" not in captured


def test_forex_pair_from_uncost_posting(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(session, _FOREX_SEED)
    captured: list[str] = []

    def fake_fetch(ticker: str, d: date) -> tuple[Decimal, str] | None:
        captured.append(ticker)
        return Decimal("0.89"), "CHF"

    monkeypatch.setattr("family_ledger_importers.prices.fetch_yahoo_close", fake_fetch)
    _run_prices(session, {"date": "2026-06-11"})

    assert "USDCHF=X" in captured


def test_ticker_from_commodity_ticker_field(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(session, _TICKER_META_SEED)
    captured: list[str] = []

    def fake_fetch(ticker: str, d: date) -> tuple[Decimal, str] | None:
        captured.append(ticker)
        return Decimal("98.70"), "CHF"

    monkeypatch.setattr("family_ledger_importers.prices.fetch_yahoo_close", fake_fetch)
    _run_prices(session, {"date": "2026-06-11"})

    assert "NESN.SW" in captured
    assert "NESN" not in captured


def test_yahoo_quote_override_stored_with_correct_quote(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # commodity has yahoo_quote: "CHF"; Yahoo API returns "USD" — override wins
    _seed(session, _YAHOO_QUOTE_META_SEED)
    monkeypatch.setattr(
        "family_ledger_importers.prices.fetch_yahoo_close",
        lambda ticker, d: (Decimal("98.70"), "USD"),
    )
    _run_prices(session, {"date": "2026-06-11"})

    price = session.scalar(select(Price).where(Price.base_symbol == "NESN"))
    assert price is not None
    assert price.quote_symbol == "CHF"


def test_fallback_to_api_currency_when_no_yahoo_quote(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # commodity has yahoo_ticker but no yahoo_quote → use API currency
    _seed(session, _TICKER_META_SEED)
    monkeypatch.setattr(
        "family_ledger_importers.prices.fetch_yahoo_close",
        lambda ticker, d: (Decimal("98.70"), "CHF"),
    )
    _run_prices(session, {"date": "2026-06-11"})

    price = session.scalar(select(Price).where(Price.base_symbol == "NESN"))
    assert price is not None
    assert price.quote_symbol == "CHF"


def test_no_data_emits_warning_and_no_price_created(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(session, _EQUITY_SEED)
    monkeypatch.setattr(
        "family_ledger_importers.prices.fetch_yahoo_close",
        lambda ticker, d: None,
    )
    result = _run_prices(session, {"date": "2026-06-11"})

    assert any("No price data" in w for w in result.warnings)
    assert session.scalar(select(func.count()).select_from(Price)) == 0


def test_duplicate_counted_not_errored(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(session, _EQUITY_SEED)
    monkeypatch.setattr(
        "family_ledger_importers.prices.fetch_yahoo_close",
        lambda ticker, d: (Decimal("100.50"), "CHF"),
    )
    _run_prices(session, {"date": "2026-06-11"})
    result = _run_prices(session, {"date": "2026-06-11"})

    assert result.entities["price"].duplicate == 1
    assert session.scalar(select(func.count()).select_from(Price)) == 1


def test_missing_date_raises_validation_error(session: Session) -> None:
    with pytest.raises(ValidationError) as exc_info:
        _run_prices(session, {})
    assert exc_info.value.code == "missing_date"


def test_invalid_date_format_raises_validation_error(session: Session) -> None:
    with pytest.raises(ValidationError) as exc_info:
        _run_prices(session, {"date": "11/06/2026"})
    assert exc_info.value.code == "invalid_date"


def test_base_currency_not_fetched(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(session, _EQUITY_SEED)
    captured: list[str] = []

    def fake_fetch(ticker: str, d: date) -> tuple[Decimal, str] | None:
        captured.append(ticker)
        return Decimal("100.50"), "CHF"

    monkeypatch.setattr("family_ledger_importers.prices.fetch_yahoo_close", fake_fetch)
    _run_prices(session, {"date": "2026-06-11"})

    assert "CHF" not in captured
    assert "CHFCHF=X" not in captured
