from __future__ import annotations

from collections.abc import Generator
from datetime import date

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.api.schemas import AccountCreate
from family_ledger.models import Account, Base
from family_ledger.services import accounts as accounts_service
from family_ledger.services.errors import NotFoundError


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


def test_update_account_modifies_fields_and_returns_updated(session: Session) -> None:
    session.add(
        Account(
            name="accounts/acc_one",
            account_name="Assets:Bank:Checking",
            effective_start_date=date(2020, 1, 1),
        )
    )
    session.commit()

    updated = accounts_service.update_account(
        session,
        "acc_one",
        AccountCreate(
            account_name="Assets:Bank:Savings",
            effective_start_date=date(2021, 1, 1),
        ),
    )

    assert updated.account_name == "Assets:Bank:Savings"
    assert updated.effective_start_date == date(2021, 1, 1)
    assert updated.name == "accounts/acc_one"


def test_update_account_raises_for_missing_account(session: Session) -> None:
    with pytest.raises(NotFoundError) as exc_info:
        accounts_service.update_account(
            session,
            "acc_missing",
            AccountCreate(
                account_name="Assets:Bank",
                effective_start_date=date(2020, 1, 1),
            ),
        )

    assert exc_info.value.code == "account_not_found"
