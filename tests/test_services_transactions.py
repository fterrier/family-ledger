from __future__ import annotations

from collections.abc import Generator
from datetime import date, datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import cast

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    DoctorIssue,
    DoctorLedgerRequest,
    ImportMetadata,
    MoneyValue,
    PostingPayload,
    SplitTransactionRequest,
    TransactionCreate,
    UnsplitTransactionRequest,
)
from family_ledger.models import Account, Base, Commodity
from family_ledger.services import doctor as doctor_service
from family_ledger.services import transactions as transactions_service
from family_ledger.services.errors import ConflictError, NotFoundError, ValidationError
from family_ledger.services.validation import resolve_accounts


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
        import_metadata=ImportMetadata(source_native_ids=["source-1"]),
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


def test_create_transaction_persists_explicit_unbalanced_payload_with_filler_posting(
    session: Session,
) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
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

    assert len(created.postings) == 3
    assert created.postings[2].account is None
    assert created.postings[2].units == MoneyValue(amount=Decimal("1.00"), symbol="CHF")


def test_create_transaction_persists_one_filler_posting_per_unbalanced_symbol(
    session: Session,
) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
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
                    units=MoneyValue(amount=Decimal("50.00"), symbol="USD"),
                ),
            ],
        ),
    )

    assert len(created.postings) == 4
    fillers = {p.units.symbol: p.units.amount for p in created.postings[2:]}
    assert fillers == {"CHF": Decimal("100.00"), "USD": Decimal("-50.00")}
    assert all(p.account is None for p in created.postings[2:])


def test_persist_transaction_sets_generated_name_source_native_ids_and_posting_order(
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
                    narration="Household allocation",
                ),
            ]
        }
    )
    transaction = transactions_service.persist_transaction(
        session, payload, account_map=resolve_accounts(session, payload.postings)
    )

    assert transaction.name.startswith("transactions/txn_")
    assert transaction.source_native_ids == ["source-1"]
    assert [posting.posting_order for posting in transaction.postings] == [1, 2]
    assert transaction.postings[0].units_amount == Decimal("-100.00")
    assert transaction.postings[1].units_symbol == "CHF"
    assert transaction.postings[1].narration == "Household allocation"


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

    created = transactions_service.create_transaction(
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

    updated = transactions_service.update_transaction(
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


def test_update_transaction_with_mask_preserves_unlisted_metadata(
    session: Session,
) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries",
            import_metadata=ImportMetadata(source_native_ids=["source-1"]),
            entity_metadata={"bank": "UBS", "raw_id": "tx-42"},
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
        ),
    )

    assert created.import_metadata is not None
    assert created.import_metadata.source_native_ids == ["source-1"]
    assert created.entity_metadata == {"bank": "UBS", "raw_id": "tx-42"}

    updated = transactions_service.update_transaction(
        session,
        created.name,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries updated",
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
        ),
        update_mask="transaction_date,payee,narration,postings",
    )

    assert updated.import_metadata is not None
    assert updated.import_metadata.source_native_ids == ["source-1"]
    assert updated.entity_metadata == {"bank": "UBS", "raw_id": "tx-42"}
    assert updated.narration == "Groceries updated"


def test_update_transaction_with_mask_clears_masked_field(
    session: Session,
) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries",
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
        ),
    )

    updated = transactions_service.update_transaction(
        session,
        created.name,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee=None,
            narration="Groceries",
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
        ),
        update_mask="transaction_date,payee,narration,postings",
    )

    assert updated.payee is None


def test_update_transaction_round_trips_posting_narration(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries",
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                    narration="Produce",
                ),
            ],
        ),
    )

    updated = transactions_service.update_transaction(
        session,
        created.name,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries",
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                    narration="Produce",
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("40.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    assert [posting.narration for posting in updated.postings] == [None, "Produce", None]


def test_update_transaction_clears_posting_narration(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries",
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                    narration="Produce",
                ),
            ],
        ),
    )

    updated = transactions_service.update_transaction(
        session,
        created.name,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries",
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
        ),
    )

    assert updated.postings[1].narration is None


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

    created = transactions_service.create_transaction(
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

    updated = transactions_service.update_transaction(
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

    unbalanced = transactions_service.create_transaction(
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
    transactions_service.create_transaction(
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
    transactions_service.create_transaction(
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
    crossing = transactions_service.create_transaction(
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
            target_summary={"date": "2026-04-01"},
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
            target_summary={"date": "2026-04-04"},
            code="lot_match_missing",
            severity="error",
            message="Not enough lots to reduce.",
            details={
                "account": "Assets:Broker:Stocks",
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
        transactions_service.update_transaction(
            session,
            "transactions/txn_missing",
            make_transaction_payload(),
        )
    assert exc_info.value.code == "transaction_not_found"


# ---------------------------------------------------------------------------
# Accountless postings (Phase 1: nullable posting account)
# ---------------------------------------------------------------------------


def test_create_transaction_persists_accountless_posting(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account=None,
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    accountless = created.postings[1]
    assert accountless.account is None
    assert accountless.account_name is None
    assert accountless.weight is not None
    assert accountless.weight.amount == Decimal("100.00")


def test_update_transaction_round_trip_preserves_accountless_posting(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account=None,
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    reloaded = transactions_service.update_transaction(
        session,
        created.name,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[p for p in created.postings],
        ),
    )

    assert reloaded.postings[1].account is None


def test_update_transaction_can_introduce_accountless_posting(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(
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
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    updated = transactions_service.update_transaction(
        session,
        created.name,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account=None,
                    units=MoneyValue(amount=Decimal("40.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    assert updated.postings[2].account is None


def test_merge_transactions_handles_accountless_postings(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    primary = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account=None,
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    secondary = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-5.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account=None,
                    units=MoneyValue(amount=Decimal("5.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    merged = transactions_service.merge_transactions(session, primary.name, secondary.name)

    assert sum(1 for p in merged.postings if p.account is None) == 2


def test_merge_transactions_does_not_dedupe_unrelated_accountless_postings(
    session: Session,
) -> None:
    # _posting_key's dedup tuple includes account_id — for two accountless
    # postings that's always None, so two *unrelated* accountless postings
    # (each covering a different transaction's own gap) must never be
    # treated as "the same posting" just because their amount/symbol happen
    # to match too. Regression test: both fillers here are 50.00 CHF.
    seed_basic_transaction_dependencies(session)

    primary = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-50.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    secondary = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-50.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    assert primary.postings[1].account is None
    assert secondary.postings[1].account is None

    merged = transactions_service.merge_transactions(session, primary.name, secondary.name)

    assert sum(1 for p in merged.postings if p.account is None) == 2
    assert sum(p.units.amount for p in merged.postings) == Decimal("0")


# ---------------------------------------------------------------------------
# update_time (Phase 1: optimistic-concurrency timestamp)
# ---------------------------------------------------------------------------


def _seeded_transaction_payload() -> TransactionCreate:
    return TransactionCreate(
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


def test_create_transaction_sets_update_time(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(session, _seeded_transaction_payload())

    assert created.update_time is not None
    assert isinstance(created.update_time, int)


def test_update_transaction_bumps_update_time(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    created = transactions_service.create_transaction(session, _seeded_transaction_payload())

    # Force a distinguishable timestamp regardless of how fast the test runs.
    baseline = created.update_time - 5
    session.execute(
        text("UPDATE transactions SET updated_at = :ts WHERE name = :name").bindparams(
            ts=baseline, name=created.name
        )
    )
    session.commit()

    updated = transactions_service.update_transaction(
        session,
        created.name,
        _seeded_transaction_payload().model_copy(update={"narration": "Changed"}),
    )

    assert updated.update_time > baseline


# ---------------------------------------------------------------------------
# split_transaction / unsplit_transaction (Phase 3)
# ---------------------------------------------------------------------------


def _seed_split_dependencies(session: Session) -> None:
    session.add_all(
        [
            Account(
                name="accounts/acc_one",
                account_name="Assets:Bank:Checking:Family",
                effective_start_date=date(2020, 1, 1),
            ),
            Account(
                name="accounts/acc_two",
                account_name="Expenses:Food",
                effective_start_date=date(2020, 1, 1),
            ),
            Account(
                name="accounts/acc_three",
                account_name="Expenses:Household",
                effective_start_date=date(2020, 1, 1),
            ),
            Commodity(name="commodities/cmd_chf", symbol="CHF"),
            Commodity(name="commodities/cmd_usd", symbol="USD"),
        ]
    )
    session.commit()


def _create_split_test_transaction(session: Session, amount: Decimal = Decimal("80.45")):
    return transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=-amount, symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=amount, symbol="CHF"),
                    narration="Groceries",
                ),
            ],
        ),
    )


def test_split_transaction_split_off_amount_produces_exact_remainder(session: Session) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session, Decimal("80.45"))

    result = transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=1,
            split_off_amount=Decimal("0.46"),
            update_time=created.update_time,
        ),
    )

    amounts = [p.units.amount for p in result.postings]
    assert amounts == [Decimal("-80.45"), Decimal("79.99"), Decimal("0.46")]
    assert result.postings[2].account is None
    assert result.postings[2].account_name is None


def test_split_transaction_zero_split_off_amount_is_a_no_op(session: Session) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session, Decimal("80.45"))

    result = transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=1,
            split_off_amount=Decimal("0"),
            update_time=created.update_time,
        ),
    )

    assert len(result.postings) == 2
    assert result.postings[1].units.amount == Decimal("80.45")


def test_split_transaction_rejects_index_out_of_range(session: Session) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session)

    with pytest.raises(ValidationError) as exc_info:
        transactions_service.split_transaction(
            session,
            created.name,
            SplitTransactionRequest(
                posting_index=5, split_off_amount=Decimal("1"), update_time=created.update_time
            ),
        )
    assert exc_info.value.code == "posting_index_out_of_range"


def test_split_transaction_rejects_negative_index(session: Session) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session)

    with pytest.raises(ValidationError) as exc_info:
        transactions_service.split_transaction(
            session,
            created.name,
            SplitTransactionRequest(
                posting_index=-1, split_off_amount=Decimal("1"), update_time=created.update_time
            ),
        )
    assert exc_info.value.code == "posting_index_out_of_range"


def test_split_transaction_can_split_an_accountless_posting(session: Session) -> None:
    # posting_index isn't restricted to accounted postings — splitting an
    # already-accountless posting (e.g. further dividing an uncategorized
    # remainder) is allowed and simply produces two accountless postings.
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account=None,
                    units=MoneyValue(amount=Decimal("100.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    assert created.postings[1].account is None

    result = transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=1, split_off_amount=Decimal("30.00"), update_time=created.update_time
        ),
    )

    assert len(result.postings) == 3
    assert result.postings[1].account is None
    assert result.postings[1].units.amount == Decimal("70.00")
    assert result.postings[2].account is None
    assert result.postings[2].units.amount == Decimal("30.00")


def test_split_transaction_copies_cost_to_remainder_posting(session: Session) -> None:
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
            Commodity(name="commodities/cmd_goog", symbol="GOOG"),
            Commodity(name="commodities/cmd_usd", symbol="USD"),
        ]
    )
    session.commit()
    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-500.00"), symbol="USD"),
                ),
            ],
        ),
    )

    result = transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=0, split_off_amount=Decimal("2"), update_time=created.update_time
        ),
    )

    target, remainder = result.postings[0], result.postings[1]
    assert target.units.amount == Decimal("3")
    assert target.cost is not None
    assert target.cost.amount == Decimal("100.00")
    assert remainder.units.amount == Decimal("2")
    assert remainder.account is None
    assert remainder.cost is not None
    assert remainder.cost.amount == Decimal("100.00")
    assert remainder.cost.symbol == "USD"


def test_split_transaction_produces_fresh_update_time_and_no_filler_posting(
    session: Session,
) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session, Decimal("80.45"))
    # Force a detectable gap — a same-wall-clock-second create+split can't
    # be distinguished by the second-precision update_time (see plan's
    # Known risks); this test wants to prove a real bump happened.
    baseline = created.update_time - 5
    session.execute(
        text("UPDATE transactions SET updated_at = :ts WHERE name = :name").bindparams(
            ts=baseline, name=created.name
        )
    )
    session.commit()

    result = transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=1,
            split_off_amount=Decimal("0.46"),
            update_time=baseline,
        ),
    )

    # A split preserves the transaction's total (target's amount is carved
    # in two) — the accountless remainder does not, by itself, reopen a
    # full-balance gap, so no filler posting is appended on top of it.
    assert len(result.postings) == 3
    assert result.update_time > baseline


def test_split_transaction_rejects_stale_update_time(session: Session) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session, Decimal("80.45"))
    # Same forced-gap technique as above, needed so the second (stale) call
    # below is unambiguously distinguishable from the first's bump.
    stale_update_time = created.update_time - 5
    session.execute(
        text("UPDATE transactions SET updated_at = :ts WHERE name = :name").bindparams(
            ts=stale_update_time, name=created.name
        )
    )
    session.commit()

    transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=1,
            split_off_amount=Decimal("0.46"),
            update_time=stale_update_time,
        ),
    )

    with pytest.raises(ConflictError) as exc_info:
        transactions_service.split_transaction(
            session,
            created.name,
            SplitTransactionRequest(
                posting_index=1,
                split_off_amount=Decimal("0.10"),
                update_time=stale_update_time,
            ),
        )
    assert exc_info.value.code == "transaction_version_mismatch"


def test_unsplit_transaction_auto_merges_into_first_sign_matching_posting(
    session: Session,
) -> None:
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
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
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("40.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=2, update_time=created.update_time),
    )

    assert len(result.postings) == 2
    assert result.postings[1].account == "accounts/acc_two"
    assert result.postings[1].units.amount == Decimal("100.00")


def test_unsplit_transaction_auto_detected_target_need_not_be_adjacent(
    session: Session,
) -> None:
    # Auto-detection scans forward for the first sign/symbol/cost/price
    # match, skipping only posting_index itself — no positional-adjacency
    # requirement. Here index 1 merges into index 2 (not index 0, which
    # never matches since it's the only negative-sign posting).
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
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
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("40.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=1, update_time=created.update_time),
    )

    assert len(result.postings) == 2
    assert result.postings[1].account == "accounts/acc_three"
    assert result.postings[1].units.amount == Decimal("100.00")


def test_unsplit_transaction_source_protection_never_selects_the_negative_source(
    session: Session,
) -> None:
    # The reason auto-detection requires a sign match, not just
    # symbol/cost/price: without it, a plain first-match scan from index 0
    # would almost always pick the negative "source" posting first in the
    # common no-cost/price case, silently corrupting it. Here unsplitting C
    # must merge into B (the first *positive* match), never into A.
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
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
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("40.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=2, update_time=created.update_time),
    )

    assert len(result.postings) == 2
    assert result.postings[0].account == "accounts/acc_one"
    assert result.postings[0].units.amount == Decimal("-100.00")
    assert result.postings[1].account == "accounts/acc_two"
    assert result.postings[1].units.amount == Decimal("100.00")


def test_unsplit_transaction_can_merge_an_accounted_posting_into_a_filler(
    session: Session,
) -> None:
    # Merging an accounted posting into a sign/symbol-matching accountless
    # filler is a valid way to move it back to "not yet categorized" — the
    # reverse of the ordinary "categorize a filler" direction. Auto-detection
    # doesn't exclude accountless candidates.
    seed_basic_transaction_dependencies(session)
    created = transactions_service.create_transaction(
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
                    units=MoneyValue(amount=Decimal("80.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    # acc_two (+80.00) is 20.00 short of balancing acc_one (-100.00), so
    # persist_transaction auto-fills a +20.00 accountless posting — a
    # sign-matching (positive), symbol-matching (CHF), no-cost/price
    # candidate that acc_two's unsplit auto-merges into.
    assert len(created.postings) == 3
    assert created.postings[2].account is None

    result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=1, update_time=created.update_time),
    )

    assert len(result.postings) == 2
    assert result.postings[1].account is None
    assert result.postings[1].units.amount == Decimal("100.00")


def test_unsplit_transaction_auto_merges_accountless_posting_into_sign_matching_destination(
    session: Session,
) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session, Decimal("80.45"))
    split_result = transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=1, split_off_amount=Decimal("0.45"), update_time=created.update_time
        ),
    )
    assert split_result.postings[2].account is None

    result = transactions_service.unsplit_transaction(
        session,
        split_result.name,
        UnsplitTransactionRequest(posting_index=2, update_time=split_result.update_time),
    )

    assert len(result.postings) == 2
    assert result.postings[1].units.amount == Decimal("80.45")


def test_unsplit_transaction_removing_accountless_posting_with_no_match_is_a_no_op(
    session: Session,
) -> None:
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
            ],
        ),
    )
    assert len(created.postings) == 2
    assert created.postings[1].account is None

    result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=1, update_time=created.update_time),
    )

    # persist_transaction re-synthesizes an equivalent filler for the
    # reopened gap — net stored state is unchanged.
    assert len(result.postings) == 2
    assert result.postings[0].units.amount == Decimal("-100.00")
    assert result.postings[1].account is None
    assert result.postings[1].units.amount == Decimal("100.00")


def test_unsplit_transaction_rejects_removing_accounted_posting_with_no_merge_target(
    session: Session,
) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session, Decimal("84.25"))

    with pytest.raises(ValidationError) as exc_info:
        transactions_service.unsplit_transaction(
            session,
            created.name,
            UnsplitTransactionRequest(posting_index=1, update_time=created.update_time),
        )
    assert exc_info.value.code == "merge_target_not_found"


def test_unsplit_transaction_leaves_narration_untouched(session: Session) -> None:
    # unsplit only merges the target's amount into the survivor — it never
    # promotes the survivor's posting-level narration to the transaction
    # level, and never clears it either. The removed target's own narration
    # simply disappears along with the rest of the deleted posting (not
    # because of any narration-specific handling).
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            narration="Weekly shop",
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-100.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                    narration="Cleaning supplies",
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("40.00"), symbol="CHF"),
                    narration="Discarded with the removed posting",
                ),
            ],
        ),
    )

    result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=2, update_time=created.update_time),
    )

    assert len(result.postings) == 2
    assert result.narration == "Weekly shop"
    assert result.postings[1].narration == "Cleaning supplies"


def test_unsplit_transaction_exact_decimal_addition(session: Session) -> None:
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-0.30"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("0.10"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("0.20"), symbol="CHF"),
                ),
            ],
        ),
    )

    result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=2, update_time=created.update_time),
    )

    assert len(result.postings) == 2
    assert result.postings[1].units.amount == Decimal("0.30")


def test_unsplit_transaction_posting_index_zero_rejected_when_no_sign_matching_target(
    session: Session,
) -> None:
    # Index 0 (conventionally "the source") is not special to the backend —
    # it's just another posting index. It's rejected here not because it's
    # index 0, but because it's negative and the only other posting is
    # positive — sign-matching finds no candidate, and an accounted
    # posting's amount is never discarded outright.
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session)

    with pytest.raises(ValidationError) as exc_info:
        transactions_service.unsplit_transaction(
            session,
            created.name,
            UnsplitTransactionRequest(posting_index=0, update_time=created.update_time),
        )
    assert exc_info.value.code == "merge_target_not_found"


def test_unsplit_transaction_rejects_index_out_of_range(session: Session) -> None:
    _seed_split_dependencies(session)
    created = _create_split_test_transaction(session)

    with pytest.raises(ValidationError) as exc_info:
        transactions_service.unsplit_transaction(
            session,
            created.name,
            UnsplitTransactionRequest(posting_index=9, update_time=created.update_time),
        )
    assert exc_info.value.code == "posting_index_out_of_range"


def test_unsplit_transaction_rejects_stale_update_time(session: Session) -> None:
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
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
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("40.00"), symbol="CHF"),
                ),
            ],
        ),
    )

    # Force a detectable gap — a same-wall-clock-second create+split can't
    # be distinguished by the second-precision update_time (see plan's
    # Known risks).
    baseline = created.update_time - 5
    session.execute(
        text("UPDATE transactions SET updated_at = :ts WHERE name = :name").bindparams(
            ts=baseline, name=created.name
        )
    )
    session.commit()

    split_result = transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=1, split_off_amount=Decimal("10.00"), update_time=baseline
        ),
    )
    assert len(split_result.postings) == 4

    with pytest.raises(ConflictError) as exc_info:
        transactions_service.unsplit_transaction(
            session,
            created.name,
            # Stale: pre-split (forced-baseline) update_time, but the
            # transaction has since changed shape (4 postings now, not 3) —
            # must be rejected rather than merging against shifted indexes.
            UnsplitTransactionRequest(posting_index=2, update_time=baseline),
        )
    assert exc_info.value.code == "transaction_version_mismatch"


def test_unsplit_transaction_no_match_on_symbol_mismatch_rejects_accounted_posting(
    session: Session,
) -> None:
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
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
                    units=MoneyValue(amount=Decimal("60.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_three",
                    units=MoneyValue(amount=Decimal("42.55"), symbol="USD"),
                ),
            ],
        ),
    )

    with pytest.raises(ValidationError) as exc_info:
        transactions_service.unsplit_transaction(
            session,
            created.name,
            UnsplitTransactionRequest(posting_index=2, update_time=created.update_time),
        )
    assert exc_info.value.code == "merge_target_not_found"


def test_unsplit_transaction_merges_matching_cost(session: Session) -> None:
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
            Commodity(name="commodities/cmd_goog", symbol="GOOG"),
            Commodity(name="commodities/cmd_usd", symbol="USD"),
        ]
    )
    session.commit()
    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-500.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("3"), symbol="GOOG"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("2"), symbol="GOOG"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
            ],
        ),
    )

    result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=2, update_time=created.update_time),
    )

    merged = next(p for p in result.postings if p.units.amount == Decimal("5"))
    assert merged.cost is not None
    assert merged.cost.amount == Decimal("100.00")


def test_unsplit_transaction_no_match_on_cost_mismatch_rejects_accounted_posting(
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
            Commodity(name="commodities/cmd_goog", symbol="GOOG"),
            Commodity(name="commodities/cmd_usd", symbol="USD"),
        ]
    )
    session.commit()
    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            postings=[
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-560.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("3"), symbol="GOOG"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("2"), symbol="GOOG"),
                    cost=MoneyValue(amount=Decimal("110.00"), symbol="USD"),
                ),
            ],
        ),
    )

    with pytest.raises(ValidationError) as exc_info:
        transactions_service.unsplit_transaction(
            session,
            created.name,
            UnsplitTransactionRequest(posting_index=2, update_time=created.update_time),
        )
    assert exc_info.value.code == "merge_target_not_found"


def test_split_and_unsplit_leave_transaction_metadata_untouched(session: Session) -> None:
    # :split/:unsplit persist with update_mask="postings" — payee, narration,
    # tags, entity_metadata, and import_metadata must survive both untouched,
    # since only the postings field is meant to change.
    _seed_split_dependencies(session)
    created = transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 19),
            payee="Migros",
            narration="Groceries",
            tags=["family", "essentials"],
            entity_metadata={"custom_key": "custom_value", "nested": {"a": 1}},
            import_metadata=ImportMetadata(
                source_native_ids=["source-1"], import_timestamp=datetime(2026, 4, 19, 12, 0, 0)
            ),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-80.45"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("80.45"), symbol="CHF"),
                ),
            ],
        ),
    )
    metadata_fields = ("payee", "narration", "tags", "entity_metadata", "import_metadata")
    original = {field: getattr(created, field) for field in metadata_fields}

    split_result = transactions_service.split_transaction(
        session,
        created.name,
        SplitTransactionRequest(
            posting_index=1, split_off_amount=Decimal("0.45"), update_time=created.update_time
        ),
    )
    for field in metadata_fields:
        assert getattr(split_result, field) == original[field], field

    unsplit_result = transactions_service.unsplit_transaction(
        session,
        created.name,
        UnsplitTransactionRequest(posting_index=2, update_time=split_result.update_time),
    )
    for field in metadata_fields:
        assert getattr(unsplit_result, field) == original[field], field


# ---------------------------------------------------------------------------
# PostgreSQL-specific SQL generation for _check_source_ids_available
# ---------------------------------------------------------------------------


class _CapturingFakeSession:
    """Session stub that reports a given dialect and captures executed SQL strings."""

    def __init__(self, dialect_name: str) -> None:
        self._dialect_name = dialect_name
        self.captured_sql: list[str] = []

    def get_bind(self):
        return SimpleNamespace(dialect=SimpleNamespace(name=self._dialect_name))

    def execute(self, statement):
        self.captured_sql.append(str(statement))
        return SimpleNamespace(all=lambda: [])


def test_check_source_ids_available_postgresql_omits_is_null_when_exclude_none() -> None:
    # psycopg3 raises AmbiguousParameter when a NULL value is bound to a parameter
    # that only appears in IS NULL — it cannot infer the PostgreSQL type.
    # The PostgreSQL SQL must not include "IS NULL" when exclude_name is None;
    # instead the exclude clause should be omitted entirely.
    fake = _CapturingFakeSession("postgresql")
    transactions_service._check_source_ids_available(
        cast(Session, fake), ["ibkr:12345678"], exclude_name=None
    )
    assert fake.captured_sql, "expected SQL to be executed"
    assert "IS NULL" not in fake.captured_sql[0], (
        "PostgreSQL SQL must not use 'IS NULL' for the exclude parameter when "
        "exclude_name is None; psycopg3 cannot infer the type and raises "
        "AmbiguousParameter (see: sqlalche.me/e/20/f405)"
    )


def test_check_source_ids_available_postgresql_omits_is_null_when_exclude_given() -> None:
    # When exclude_name is provided the clause must be "t.name != :exclude"
    # (no IS NULL), so psycopg3 can infer the type from the VARCHAR column comparison.
    fake = _CapturingFakeSession("postgresql")
    transactions_service._check_source_ids_available(
        cast(Session, fake), ["ibkr:12345678"], exclude_name="transactions/txn_abc"
    )
    assert fake.captured_sql, "expected SQL to be executed"
    assert "IS NULL" not in fake.captured_sql[0], (
        "PostgreSQL SQL must not use 'IS NULL' for the exclude parameter even "
        "when exclude_name is provided"
    )
