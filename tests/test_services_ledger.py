from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    DoctorIssue,
    DoctorLedgerRequest,
    ImportMetadata,
    MoneyValue,
    PostingPayload,
    TransactionCreate,
)
from family_ledger.models import Account, Base, Commodity
from family_ledger.services import doctor as doctor_service
from family_ledger.services import ledger as ledger_service
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


def make_transaction_payload() -> TransactionCreate:
    return TransactionCreate(
        transaction_date=date(2026, 4, 19),
        payee="Migros",
        narration="Groceries",
        import_metadata=ImportMetadata(source_native_id="source-1"),
        postings=[
            PostingPayload(
                account="accounts/checking-family",
                units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
            ),
            PostingPayload(
                account="accounts/expenses-uncategorized",
                units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
            ),
        ],
    )


def seed_basic_transaction_dependencies(session: Session) -> None:
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
            Commodity(name="commodities/cmd_usd", symbol="USD"),
            Commodity(name="commodities/cmd_goog", symbol="GOOG"),
        ]
    )
    session.commit()


def test_hash_transaction_payload_is_deterministic() -> None:
    payload = make_transaction_payload()
    fingerprint_one = ledger_service.hash_transaction_payload(payload)
    fingerprint_two = ledger_service.hash_transaction_payload(payload)
    assert fingerprint_one == fingerprint_two
    assert fingerprint_one.startswith("sha256:")


def test_transaction_fingerprint_content_excludes_import_metadata() -> None:
    payload = make_transaction_payload()
    content = ledger_service.transaction_fingerprint_content(payload)
    assert "import_metadata" not in content
    assert content["transaction_date"] == "2026-04-19"


def test_hash_transaction_payload_changes_when_content_changes() -> None:
    payload = make_transaction_payload()
    updated_payload = payload.model_copy(update={"narration": "Household"})
    assert ledger_service.hash_transaction_payload(
        payload
    ) != ledger_service.hash_transaction_payload(updated_payload)


def test_create_transaction_persists_explicit_unbalanced_payload_without_inline_issues(
    session: Session,
) -> None:
    seed_basic_transaction_dependencies(session)

    created = ledger_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("99.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    assert not hasattr(created, "issues")


def test_persist_transaction_sets_generated_name_fingerprint_and_posting_order(
    session: Session,
) -> None:
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

    payload = make_transaction_payload().model_copy(
        update={
            "postings": [
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
            ]
        }
    )
    transaction = ledger_service.persist_transaction(session, payload)

    assert transaction.name.startswith("transactions/txn_")
    assert transaction.source_native_id == "source-1"
    assert transaction.fingerprint == ledger_service.hash_transaction_payload(payload)
    assert [posting.posting_order for posting in transaction.postings] == [1, 2]
    assert transaction.postings[0].units_amount == Decimal("-100.00")
    assert transaction.postings[1].units_symbol == "CHF"


def test_update_transaction_preserves_identity_and_rewrites_postings(session: Session) -> None:
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
            Account(
                name="accounts/acc_three",
                account_name="Expenses:Food",
                effective_start_date=date(2020, 1, 1),
            ),
            Commodity(name="commodities/cmd_chf", symbol="CHF"),
        ]
    )
    session.commit()

    created = ledger_service.create_transaction(
        session,
        make_transaction_payload().model_copy(
            update={
                "postings": [
                    PostingPayload(
                        account="accounts/acc_one",
                        units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                    ),
                    PostingPayload(
                        account="accounts/acc_two",
                        units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                    ),
                ]
            }
        ),
    )

    updated = ledger_service.update_transaction(
        session,
        created.name,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Food split",
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("40.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    assert updated.name == created.name
    assert [posting.account for posting in updated.postings] == [
        "accounts/acc_one",
        "accounts/acc_three",
        "accounts/acc_two",
    ]
    assert updated.narration == "Food split"


def test_update_transaction_recomputes_fingerprint(session: Session) -> None:
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

    payload = make_transaction_payload().model_copy(
        update={
            "postings": [
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
            ]
        }
    )
    created = ledger_service.create_transaction(session, payload)
    updated = ledger_service.update_transaction(
        session,
        created.name,
        payload.model_copy(update={"narration": "Household"}),
    )

    assert updated.import_metadata is not None
    assert created.import_metadata is not None
    assert updated.import_metadata.fingerprint != created.import_metadata.fingerprint


def test_update_transaction_allows_total_change_without_lock(session: Session) -> None:
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

    created = ledger_service.create_transaction(
        session,
        make_transaction_payload().model_copy(
            update={
                "postings": [
                    PostingPayload(
                        account="accounts/acc_one",
                        units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                    ),
                    PostingPayload(
                        account="accounts/acc_two",
                        units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                    ),
                ]
            }
        ),
    )

    updated = ledger_service.update_transaction(
        session,
        created.name,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries",
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-120.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("120.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    assert updated.postings[0].units.amount == Decimal("-120.00")


def test_doctor_ledger_reports_unbalanced_and_fifo_lot_match_missing_issues(
    session: Session,
) -> None:
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

    unbalanced = ledger_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
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
    ledger_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 2),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("5"), symbol="AAPL"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-500.00"), symbol="USD"),
                ),
            ],
        ),
    )
    ledger_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 3),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("5"), symbol="AAPL"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-500.00"), symbol="USD"),
                ),
            ],
        ),
    )
    crossing = ledger_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 4),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-15"), symbol="AAPL"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("1500.00"), symbol="USD"),
                ),
            ],
        ),
    )

    diagnosed = doctor_service.doctor_ledger(session, DoctorLedgerRequest())

    assert diagnosed.issues == [
        DoctorIssue(
            target=unbalanced.name,
            code="transaction_unbalanced",
            severity="error",
            message="Transaction is not balanced within tolerance.",
            details={
                "symbol": "CHF",
                "residual_amount": "-1",
                "tolerance_amount": "0.01",
            },
        ),
        DoctorIssue(
            target=crossing.name,
            code="lot_match_missing",
            severity="error",
            message="Not enough lots to reduce.",
            details={
                "account": "accounts/acc_one",
                "units_symbol": "AAPL",
                "cost_symbol": "USD",
                "cost_per_unit": "100",
                "requested_amount": "15",
                "available_amount": "10",
            },
        ),
    ]


def test_update_transaction_raises_for_missing_transaction(session: Session) -> None:
    with pytest.raises(NotFoundError) as exc_info:
        ledger_service.update_transaction(
            session,
            "transactions/txn_missing",
            make_transaction_payload(),
        )

    assert exc_info.value.code == "transaction_not_found"
