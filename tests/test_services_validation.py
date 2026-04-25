from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.api.schemas import MoneyValue, PostingPayload, TransactionCreate
from family_ledger.models import Account, Base, Commodity
from family_ledger.services import validation
from family_ledger.services.errors import ValidationError


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


def test_resolve_accounts_returns_expected_accounts(session: Session) -> None:
    session.add_all(
        [
            Account(
                name="accounts/acc_one",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2020, 1, 1),
            ),
            Account(
                name="accounts/acc_two",
                account_name="Expenses:Uncategorized",
                effective_start_date=date(2020, 1, 1),
            ),
        ]
    )
    session.commit()

    postings = [
        PostingPayload(
            account="accounts/acc_one",
            units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
        ),
        PostingPayload(
            account="accounts/acc_two",
            units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
        ),
    ]

    resolved = validation.resolve_accounts(session, postings)

    assert sorted(resolved) == ["accounts/acc_one", "accounts/acc_two"]


def test_resolve_accounts_raises_for_missing_account(session: Session) -> None:
    with pytest.raises(ValidationError) as exc_info:
        validation.resolve_accounts(
            session,
            [
                PostingPayload(
                    account="accounts/missing",
                    units=MoneyValue(amount=Decimal("1"), symbol="CHF"),
                )
            ],
        )

    assert exc_info.value.code == "account_not_found"


def test_validate_account_dates_rejects_out_of_range_account() -> None:
    accounts = {
        "accounts/acc_one": Account(
            name="accounts/acc_one",
            account_name="Assets:Bank:Checking:Family",
            effective_start_date=date(2027, 1, 1),
        )
    }

    with pytest.raises(ValidationError) as exc_info:
        validation.validate_account_dates(date(2026, 4, 19), accounts)

    assert exc_info.value.code == "account_not_effective"


def test_validate_symbols_exist_rejects_missing_symbol(session: Session) -> None:
    session.add(Commodity(name="commodities/cmd_one", symbol="CHF"))
    session.commit()

    with pytest.raises(ValidationError) as exc_info:
        validation.validate_symbols_exist(session, {"CHF", "USD"})

    assert exc_info.value.code == "commodity_not_found"


def test_validate_transaction_payload_checks_accounts_and_symbols(session: Session) -> None:
    session.add_all(
        [
            Account(
                name="accounts/acc_one",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2020, 1, 1),
            ),
            Account(
                name="accounts/acc_two",
                account_name="Expenses:Uncategorized",
                effective_start_date=date(2020, 1, 1),
            ),
            Commodity(name="commodities/cmd_chf", symbol="CHF"),
        ]
    )
    session.commit()

    payload = TransactionCreate(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingPayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
            ),
            PostingPayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
            ),
        ],
    )

    validation.validate_transaction_payload(session, payload)
