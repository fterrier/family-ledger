from __future__ import annotations

from collections.abc import Generator

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session

from family_ledger.importers.base import ImportResult
from family_ledger.models import Account, BalanceAssertion, Base, Commodity, Price, Transaction
from family_ledger.services.errors import ConflictError

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

    return BeancountImporter().execute(session, text.encode("utf-8"), {})


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


def test_beancount_importer_refuses_non_empty_database(session: Session) -> None:
    session.add(Commodity(name="commodities/cmd_one", symbol="CHF"))
    session.commit()

    with pytest.raises(ConflictError) as exc_info:
        _run(session, FIXTURE)
    assert exc_info.value.code == "database_not_empty"


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
