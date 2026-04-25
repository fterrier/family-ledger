from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    DoctorLedgerRequest,
    MoneyValue,
    PostingPayload,
    TransactionCreate,
)
from family_ledger.models import Account, Base, Commodity
from family_ledger.services import doctor, ledger


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


def seed_doctor_dependencies(session: Session) -> None:
    session.add_all(
        [
            Account(
                name="accounts/acc_one",
                account_name="Assets:Broker:Stocks",
                effective_start_date=date(2020, 1, 1),
            ),
            Account(
                name="accounts/acc_two",
                account_name="Assets:Broker:Cash",
                effective_start_date=date(2020, 1, 1),
            ),
            Account(
                name="accounts/acc_three",
                account_name="Expenses:Food",
                effective_start_date=date(2020, 1, 1),
            ),
            Commodity(name="commodities/cmd_chf", symbol="CHF"),
            Commodity(name="commodities/cmd_usd", symbol="USD"),
            Commodity(name="commodities/cmd_aapl", symbol="AAPL"),
        ]
    )
    session.commit()


def test_doctor_ledger_sorts_issues_in_transaction_order(session: Session) -> None:
    seed_doctor_dependencies(session)
    second = ledger.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 2),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("99.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    first = ledger.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-90.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("89.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    assert [issue.target for issue in diagnosed.issues] == [first.name, second.name]
