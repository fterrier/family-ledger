from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from family_ledger.models import Account, Base, Commodity, Posting, Transaction


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


def test_account_name_must_be_unique(session: Session) -> None:
    session.add_all(
        [
            Account(
                name="accounts/checking-family",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2020, 1, 1),
            ),
            Account(
                name="accounts/checking-family",
                account_name="Assets:Bank:Savings:Family",
                effective_start_date=date(2020, 1, 1),
            ),
        ]
    )

    with pytest.raises(IntegrityError):
        session.commit()


def test_account_ledger_name_must_be_unique(session: Session) -> None:
    session.add_all(
        [
            Account(
                name="accounts/checking-family",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2020, 1, 1),
            ),
            Account(
                name="accounts/savings-family",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2020, 1, 1),
            ),
        ]
    )

    with pytest.raises(IntegrityError):
        session.commit()


def test_commodity_symbol_must_be_unique(session: Session) -> None:
    session.add_all(
        [
            Commodity(name="commodities/chf", symbol="CHF"),
            Commodity(name="commodities/swiss-franc", symbol="CHF"),
        ]
    )

    with pytest.raises(IntegrityError):
        session.commit()


def test_transaction_source_native_ids_defaults_to_empty_list(session: Session) -> None:
    session.add(
        Transaction(
            name="transactions/txn-1",
            transaction_date=date(2026, 4, 19),
        )
    )
    session.commit()
    tx = session.get(Transaction, 1)
    assert tx is not None
    assert tx.source_native_ids == []


def test_transaction_source_native_ids_stores_list(session: Session) -> None:
    session.add(
        Transaction(
            name="transactions/txn-1",
            transaction_date=date(2026, 4, 19),
            source_native_ids=["ibkr:123", "zkb:456"],
        )
    )
    session.commit()
    session.expire_all()
    tx = session.get(Transaction, 1)
    assert tx is not None
    assert tx.source_native_ids == ["ibkr:123", "zkb:456"]


def test_postings_are_deleted_with_transaction(session: Session) -> None:
    account = Account(
        name="accounts/checking-family",
        account_name="Assets:Bank:Checking:Family",
        effective_start_date=date(2020, 1, 1),
    )
    transaction = Transaction(
        name="transactions/txn-1",
        transaction_date=date(2026, 4, 19),
        postings=[
            Posting(
                account=account,
                posting_order=1,
                units_amount=Decimal("-100.00"),
                units_symbol="CHF",
            ),
            Posting(
                account=account,
                posting_order=2,
                units_amount=Decimal("100.00"),
                units_symbol="CHF",
            ),
        ],
    )
    session.add(transaction)
    session.commit()

    session.delete(transaction)
    session.commit()

    remaining_postings = session.scalars(select(Posting)).all()
    assert remaining_postings == []
