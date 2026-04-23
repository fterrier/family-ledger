from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session

from family_ledger.models import Account, BalanceAssertion, Base, Commodity, Price, Transaction
from scripts import import_beancount

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


@pytest.fixture
def session() -> Generator[Session, None, None]:
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)

    with Session(engine) as session:
        yield session


@pytest.fixture
def beancount_file(tmp_path: Path) -> Path:
    path = tmp_path / "fixture.beancount"
    path.write_text(FIXTURE, encoding="utf-8")
    return path


@pytest.fixture
def missing_posting_file(tmp_path: Path) -> Path:
    path = tmp_path / "missing-posting.beancount"
    path.write_text(MISSING_POSTING_FIXTURE, encoding="utf-8")
    return path


@pytest.fixture
def commodity_discovery_file(tmp_path: Path) -> Path:
    path = tmp_path / "commodity-discovery.beancount"
    path.write_text(COMMODITY_DISCOVERY_FIXTURE, encoding="utf-8")
    return path


@pytest.fixture
def tolerance_file(tmp_path: Path) -> Path:
    path = tmp_path / "tolerance.beancount"
    path.write_text(TOLERANCE_FIXTURE, encoding="utf-8")
    return path


def test_collect_unsupported_entries_is_empty_for_supported_fixture(beancount_file: Path) -> None:
    entries, errors, _options_map = import_beancount.load_beancount_document(beancount_file)

    assert errors == []
    assert import_beancount.collect_unsupported_entries(entries) == []


def test_unsupported_entry_counts_reports_custom_entries(tmp_path: Path) -> None:
    path = tmp_path / "custom-fixture.beancount"
    path.write_text('2026-04-01 custom "feature" "value"\n', encoding="utf-8")
    entries, errors, _options_map = import_beancount.load_beancount_document(path)

    assert errors == []
    counts = import_beancount.unsupported_entry_counts(entries)
    assert counts["Custom"] >= 1


def test_import_beancount_reports_skipped_entries(tmp_path: Path, session: Session) -> None:
    path = tmp_path / "custom-fixture.beancount"
    path.write_text(
        "2020-01-01 open Assets:Bank:Checking\n"
        "2020-01-01 commodity CHF\n"
        '2026-04-01 custom "feature" "value"\n',
        encoding="utf-8",
    )

    summary = import_beancount.import_beancount(session, path)

    assert summary.accounts == 1
    assert summary.commodities == 1
    assert summary.skipped_entries == {"Custom": 1}


def test_import_beancount_populates_database(session: Session, beancount_file: Path) -> None:
    summary = import_beancount.import_beancount(session, beancount_file)

    assert summary.accounts == 3
    assert summary.commodities == 1
    assert summary.transactions == 1
    assert summary.prices == 1
    assert summary.balance_assertions == 1

    assert session.scalar(select(func.count()).select_from(Account)) == 3
    assert session.scalar(select(func.count()).select_from(Commodity)) == 1
    assert session.scalar(select(func.count()).select_from(Transaction)) == 1
    assert session.scalar(select(func.count()).select_from(Price)) == 1
    assert session.scalar(select(func.count()).select_from(BalanceAssertion)) == 1


def test_import_beancount_interpolates_one_missing_posting(
    session: Session,
    missing_posting_file: Path,
) -> None:
    summary = import_beancount.import_beancount(session, missing_posting_file)

    assert summary.transactions == 1
    assert summary.skipped_transactions == 0


def test_discover_commodity_symbols_from_open_and_postings(
    commodity_discovery_file: Path,
) -> None:
    entries, errors, _options_map = import_beancount.load_beancount_document(
        commodity_discovery_file
    )

    assert errors == []
    assert import_beancount.discover_commodity_symbols(entries) == ["AAPL", "USD"]


def test_import_beancount_refuses_non_empty_database(
    session: Session, beancount_file: Path
) -> None:
    session.add(Commodity(name="commodities/cmd_one", symbol="CHF"))
    session.commit()

    with pytest.raises(RuntimeError, match="expects an empty database"):
        import_beancount.import_beancount(session, beancount_file)


def test_import_beancount_accepts_transaction_within_default_tolerance(
    session: Session, tolerance_file: Path
) -> None:
    summary = import_beancount.import_beancount(session, tolerance_file)

    assert summary.transactions == 1
    assert summary.skipped_transactions == 0
