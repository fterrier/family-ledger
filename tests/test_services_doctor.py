from __future__ import annotations

from collections.abc import Generator
from datetime import date, datetime
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
from family_ledger.models import Account, Attachment, Base, Commodity
from family_ledger.services import balance_assertions as balance_assertions_service
from family_ledger.services import commodities as commodities_service
from family_ledger.services import doctor
from family_ledger.services import transactions as transactions_service


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


def test_doctor_ledger_reports_issues_for_multiple_unbalanced_transactions(
    session: Session,
) -> None:
    seed_doctor_dependencies(session)
    tx_a = transactions_service.create_transaction(
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
    tx_b = transactions_service.create_transaction(
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

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    targets = {issue.target for issue in diagnosed.issues}
    assert tx_a.name in targets
    assert tx_b.name in targets


def test_doctor_reports_balance_assertion_failure(session: Session) -> None:
    seed_doctor_dependencies(session)
    transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("750.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("-750.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    from family_ledger.api.schemas import BalanceAssertionCreate

    ba = balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 4, 2),
            account="accounts/acc_two",
            amount=MoneyValue(amount=Decimal("1000.00"), symbol="CHF"),
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    ba_issues = [i for i in diagnosed.issues if i.code == "balance_assertion_failed"]
    assert len(ba_issues) == 1
    assert ba_issues[0].target == ba.name


def test_doctor_preserves_balance_assertion_date_order(session: Session) -> None:
    seed_doctor_dependencies(session)
    transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("750.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("-750.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    from family_ledger.api.schemas import BalanceAssertionCreate

    first = balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 4, 2),
            account="accounts/acc_two",
            amount=MoneyValue(amount=Decimal("1000.00"), symbol="CHF"),
        ),
    )
    second = balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 4, 3),
            account="accounts/acc_two",
            amount=MoneyValue(amount=Decimal("1000.00"), symbol="CHF"),
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    ba_issues = [i for i in diagnosed.issues if i.code == "balance_assertion_failed"]
    assert [issue.target for issue in ba_issues] == [first.name, second.name]


def test_doctor_no_issue_when_balance_assertion_satisfied(session: Session) -> None:
    seed_doctor_dependencies(session)
    transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("1000.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("-1000.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    from family_ledger.api.schemas import BalanceAssertionCreate

    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 4, 2),
            account="accounts/acc_two",
            amount=MoneyValue(amount=Decimal("1000.00"), symbol="CHF"),
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    assert not any(i.code == "balance_assertion_failed" for i in diagnosed.issues)


def test_doctor_reports_account_not_effective_when_transaction_predates_account_open(
    session: Session,
) -> None:
    session.add_all(
        [
            Account(
                name="accounts/acc_one",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2026, 1, 1),
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
    tx = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2025, 12, 31),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    issues = [i for i in diagnosed.issues if i.code == "account_not_effective"]
    assert len(issues) == 1
    assert issues[0].target == tx.name
    assert "Assets:Bank:Checking:Family" in issues[0].details["accounts"]


def test_doctor_reports_account_not_effective_when_transaction_postdates_account_close(
    session: Session,
) -> None:
    session.add_all(
        [
            Account(
                name="accounts/acc_one",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2020, 1, 1),
                effective_end_date=date(2025, 12, 31),
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
    tx = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 1, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    issues = [i for i in diagnosed.issues if i.code == "account_not_effective"]
    assert len(issues) == 1
    assert issues[0].target == tx.name
    assert "Assets:Bank:Checking:Family" in issues[0].details["accounts"]


def test_doctor_no_account_not_effective_issue_when_within_range(session: Session) -> None:
    session.add_all(
        [
            Account(
                name="accounts/acc_one",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2020, 1, 1),
                effective_end_date=date(2030, 12, 31),
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
    transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 1, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    assert not any(i.code == "account_not_effective" for i in diagnosed.issues)


def test_doctor_reports_unknown_commodity(session: Session) -> None:
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
            Commodity(name="commodities/cmd_xyz", symbol="XYZ"),
        ]
    )
    session.commit()
    tx = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 1, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="XYZ"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="XYZ"),
                ),
            ],
        ),
    )
    # Delete the commodity after the transaction is recorded to simulate a missing commodity.
    commodities_service.delete_commodity(session, "commodities/cmd_xyz")

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    issues = [i for i in diagnosed.issues if i.code == "unknown_commodity"]
    assert len(issues) == 1
    assert issues[0].target == tx.name
    assert issues[0].details["symbols"] == "XYZ"


def test_doctor_no_unknown_commodity_issue_when_commodity_exists(session: Session) -> None:
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
    transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 1, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    assert not any(i.code == "unknown_commodity" for i in diagnosed.issues)


def test_doctor_reports_attachment_storage_failures(session: Session) -> None:
    account = Account(
        name="accounts/acc_one",
        account_name="Assets:Bank:Checking",
        effective_start_date=date(2020, 1, 1),
    )
    session.add(account)
    session.add(
        Attachment(
            name="attachments/att_failed",
            account=account,
            attachment_date=date(2026, 5, 19),
            original_filename="failed.pdf",
            media_type="application/pdf",
            status="failed",
            document_url=None,
            storage_backend="paperless",
            storage_deadline_at=datetime(2026, 5, 20, 0, 0, 0),
            entity_metadata={},
            storage_metadata={},
        )
    )
    session.commit()

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    attachment_issues = [i for i in diagnosed.issues if i.code == "attachment_storage_failed"]
    assert len(attachment_issues) == 1
    assert attachment_issues[0].target == "attachments/att_failed"
    assert attachment_issues[0].target_summary == {
        "date": "2026-05-19",
        "account": "Assets:Bank:Checking",
        "filename": "failed.pdf",
    }
    assert attachment_issues[0].details == {}


def test_doctor_transaction_unbalanced_target_summary_includes_payee_and_narration(
    session: Session,
) -> None:
    seed_doctor_dependencies(session)
    tx = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
            payee="ACME Corp",
            narration="Monthly invoice",
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

    issues = [i for i in diagnosed.issues if i.code == "transaction_unbalanced"]
    assert len(issues) == 1
    assert issues[0].target == tx.name
    assert issues[0].target_summary == {
        "date": "2026-04-01",
        "payee": "ACME Corp",
        "narration": "Monthly invoice",
    }


def test_doctor_transaction_unbalanced_target_summary_date_only_when_no_payee_narration(
    session: Session,
) -> None:
    seed_doctor_dependencies(session)
    tx = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 5),
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

    issues = [i for i in diagnosed.issues if i.code == "transaction_unbalanced"]
    assert len(issues) == 1
    assert issues[0].target == tx.name
    assert issues[0].target_summary == {"date": "2026-04-05"}


def test_doctor_account_not_effective_target_summary(session: Session) -> None:
    session.add_all(
        [
            Account(
                name="accounts/acc_one",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2026, 1, 1),
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
    tx = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2025, 12, 31),
            payee="Some Payee",
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    issues = [i for i in diagnosed.issues if i.code == "account_not_effective"]
    assert len(issues) == 1
    assert issues[0].target == tx.name
    assert issues[0].target_summary == {"date": "2025-12-31", "payee": "Some Payee"}


def test_doctor_unknown_commodity_target_summary(session: Session) -> None:
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
            Commodity(name="commodities/cmd_xyz", symbol="XYZ"),
        ]
    )
    session.commit()
    tx = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 1, 1),
            narration="Buy something",
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="XYZ"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="XYZ"),
                ),
            ],
        ),
    )
    commodities_service.delete_commodity(session, "commodities/cmd_xyz")

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    issues = [i for i in diagnosed.issues if i.code == "unknown_commodity"]
    assert len(issues) == 1
    assert issues[0].target == tx.name
    assert issues[0].target_summary == {"date": "2026-01-01", "narration": "Buy something"}


def test_doctor_balance_assertion_failed_target_summary(session: Session) -> None:
    from family_ledger.api.schemas import BalanceAssertionCreate

    seed_doctor_dependencies(session)
    transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("750.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("-750.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    ba = balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 4, 2),
            account="accounts/acc_two",
            amount=MoneyValue(amount=Decimal("1000.00"), symbol="CHF"),
        ),
    )

    diagnosed = doctor.doctor_ledger(session, DoctorLedgerRequest())

    issues = [i for i in diagnosed.issues if i.code == "balance_assertion_failed"]
    assert len(issues) == 1
    assert issues[0].target == ba.name
    assert issues[0].target_summary == {"date": "2026-04-02", "account": "Assets:Broker:Cash"}
