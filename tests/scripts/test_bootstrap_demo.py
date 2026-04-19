from __future__ import annotations

from collections.abc import Generator
from datetime import date

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session

from family_ledger.models import Account, BalanceAssertion, Base, Commodity, Price, Transaction
from scripts import bootstrap_demo


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


def test_demo_factories_have_expected_sizes() -> None:
    assert len(bootstrap_demo.demo_accounts()) == 5
    assert len(bootstrap_demo.demo_commodities()) == 3
    assert len(bootstrap_demo.demo_transactions()) == 4
    assert len(bootstrap_demo.demo_prices()) == 1
    assert len(bootstrap_demo.demo_balance_assertions()) == 1


def test_database_is_empty_true_then_false(session: Session) -> None:
    assert bootstrap_demo.database_is_empty(session) is True

    session.add(
        Account(
            name="accounts/checking-family",
            ledger_name="Assets:Bank:Checking:Family",
            effective_start_date=date(2020, 1, 1),
        )
    )
    session.commit()

    assert bootstrap_demo.database_is_empty(session) is False


def test_bootstrap_demo_populates_empty_database(session: Session) -> None:
    bootstrap_demo.bootstrap_demo(session)

    assert session.scalar(select(func.count()).select_from(Account)) == 5
    assert session.scalar(select(func.count()).select_from(Commodity)) == 3
    assert session.scalar(select(func.count()).select_from(Transaction)) == 4
    assert session.scalar(select(func.count()).select_from(Price)) == 1
    assert session.scalar(select(func.count()).select_from(BalanceAssertion)) == 1


def test_bootstrap_demo_refuses_non_empty_database(session: Session) -> None:
    session.add(
        Commodity(
            name="commodities/chf",
            symbol="CHF",
        )
    )
    session.commit()

    with pytest.raises(RuntimeError, match="expects an empty database"):
        bootstrap_demo.bootstrap_demo(session)
