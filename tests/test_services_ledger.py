from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    ImportMetadata,
    MoneyValue,
    NormalizeMoneyValue,
    NormalizePriceValue,
    PostingNormalizePayload,
    PostingPayload,
    TransactionCreate,
    TransactionNormalizeData,
)
from family_ledger.models import Account, Base, Commodity
from family_ledger.services import ledger as ledger_service
from family_ledger.services.errors import NotFoundError, ValidationError


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
    resolved = ledger_service.resolve_accounts(session, payload.postings)

    assert sorted(resolved) == ["accounts/acc_one", "accounts/acc_two"]


def test_resolve_accounts_raises_for_missing_account(session: Session) -> None:
    with pytest.raises(ValidationError) as exc_info:
        ledger_service.resolve_accounts(session, make_transaction_payload().postings)

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
        ledger_service.validate_account_dates(date(2026, 4, 19), accounts)

    assert exc_info.value.code == "account_not_effective"


def test_validate_symbols_exist_rejects_missing_symbol(session: Session) -> None:
    session.add(Commodity(name="commodities/cmd_one", symbol="CHF"))
    session.commit()

    with pytest.raises(ValidationError) as exc_info:
        ledger_service.validate_symbols_exist(session, {"CHF", "USD"})

    assert exc_info.value.code == "commodity_not_found"


def test_resolve_tolerance_uses_symbol_override(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    assert ledger_service.resolve_tolerance(session, "CHF") == Decimal("0.01")


def test_resolve_tolerance_uses_default_when_symbol_missing(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    assert ledger_service.resolve_tolerance(session, "USD") == Decimal("0.000001")


def test_validate_transaction_balanced_allows_small_residual_within_tolerance(
    session: Session,
) -> None:
    seed_basic_transaction_dependencies(session)

    payload = TransactionCreate(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingPayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-10.005"), symbol="CHF"),
            ),
            PostingPayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("10.00"), symbol="CHF"),
            ),
        ],
    )

    assert ledger_service.derive_normalize_issues(session, payload) == []


def test_derive_normalize_issues_reports_residual_outside_default_tolerance(
    session: Session,
) -> None:
    seed_basic_transaction_dependencies(session)

    payload = TransactionCreate(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingPayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-10.00001"), symbol="EUR"),
            ),
            PostingPayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("10.00"), symbol="EUR"),
            ),
        ],
    )

    issues = ledger_service.derive_normalize_issues(session, payload)

    assert len(issues) == 1
    assert issues[0].code == "transaction_unbalanced"
    assert issues[0].details == {
        "symbol": "EUR",
        "residual_amount": "-0.00001",
        "tolerance_amount": "0.000001",
    }


def test_validate_transaction_balanced_uses_cost_weight_over_price(session: Session) -> None:
    seed_basic_transaction_dependencies(session)

    payload = TransactionCreate(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingPayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
                cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                price=MoneyValue(amount=Decimal("150.00"), symbol="USD"),
            ),
            PostingPayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("-500.00"), symbol="USD"),
            ),
        ],
    )

    assert ledger_service.derive_normalize_issues(session, payload) == []


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

    diagnosed = ledger_service.doctor_ledger(session, ledger_service.DoctorLedgerRequest())

    assert diagnosed.issues == [
        ledger_service.DoctorIssue(
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
        ledger_service.DoctorIssue(
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


def test_doctor_ledger_allows_fifo_partial_match_before_reporting_shortage(
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
            Commodity(name="commodities/cmd_usd", symbol="USD"),
            Commodity(name="commodities/cmd_aapl", symbol="AAPL"),
        ]
    )
    session.commit()

    last_created = None
    for transaction_date, stock_amount, cash_amount in [
        (date(2026, 4, 1), Decimal("5"), Decimal("-500")),
        (date(2026, 4, 2), Decimal("5"), Decimal("-500")),
        (date(2026, 4, 3), Decimal("-7"), Decimal("700")),
        (date(2026, 4, 4), Decimal("-7"), Decimal("700")),
    ]:
        last_created = ledger_service.create_transaction(
            session,
            TransactionCreate(
                transaction_date=transaction_date,
                postings=[
                    PostingPayload(
                        account="accounts/acc_one",
                        units=MoneyValue(amount=stock_amount, symbol="AAPL"),
                        cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                    ),
                    PostingPayload(
                        account="accounts/acc_two",
                        units=MoneyValue(amount=cash_amount, symbol="USD"),
                    ),
                ],
            ),
        )

    diagnosed = ledger_service.doctor_ledger(session, ledger_service.DoctorLedgerRequest())
    assert last_created is not None

    assert diagnosed.issues == [
        ledger_service.DoctorIssue(
            target=last_created.name,
            code="lot_match_missing",
            severity="error",
            message="Not enough lots to reduce.",
            details={
                "account": "accounts/acc_one",
                "units_symbol": "AAPL",
                "cost_symbol": "USD",
                "cost_per_unit": "100",
                "requested_amount": "7",
                "available_amount": "3",
            },
        )
    ]


def test_doctor_ledger_aggregates_same_lot_postings_within_transaction(session: Session) -> None:
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
            Commodity(name="commodities/cmd_usd", symbol="USD"),
            Commodity(name="commodities/cmd_aapl", symbol="AAPL"),
        ]
    )
    session.commit()

    ledger_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("5"), symbol="AAPL"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("-500"), symbol="USD"),
                ),
            ],
        ),
    )
    aggregated = ledger_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 4, 2),
            postings=[
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-3"), symbol="AAPL"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_one",
                    units=MoneyValue(amount=Decimal("-4"), symbol="AAPL"),
                    cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                ),
                PostingPayload(
                    account="accounts/acc_two",
                    units=MoneyValue(amount=Decimal("700"), symbol="USD"),
                ),
            ],
        ),
    )

    diagnosed = ledger_service.doctor_ledger(session, ledger_service.DoctorLedgerRequest())

    assert diagnosed.issues == [
        ledger_service.DoctorIssue(
            target=aggregated.name,
            code="lot_match_missing",
            severity="error",
            message="Not enough lots to reduce.",
            details={
                "account": "accounts/acc_one",
                "units_symbol": "AAPL",
                "cost_symbol": "USD",
                "cost_per_unit": "100",
                "requested_amount": "7",
                "available_amount": "5",
            },
        )
    ]


def test_update_transaction_raises_for_missing_transaction(session: Session) -> None:
    with pytest.raises(NotFoundError) as exc_info:
        ledger_service.update_transaction(
            session,
            "transactions/txn_missing",
            make_transaction_payload(),
        )

    assert exc_info.value.code == "transaction_not_found"


def test_normalize_transaction_uses_price_when_cost_absent() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("1000.00"), symbol="USD"),
                price=MoneyValue(amount=Decimal("0.92"), symbol="CHF"),
            ),
            PostingNormalizePayload(account="accounts/acc_two"),
        ],
    )

    normalized = ledger_service.normalize_transaction_payload(payload)

    assert normalized.postings[1].units is not None
    assert normalized.postings[1].units.amount == Decimal("-920.00")
    assert normalized.postings[1].units.symbol == "CHF"


def test_normalize_transaction_uses_cost_when_present() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
                cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
            ),
            PostingNormalizePayload(account="accounts/acc_two"),
        ],
    )

    normalized = ledger_service.normalize_transaction_payload(payload)

    assert normalized.postings[1].units is not None
    assert normalized.postings[1].units.amount == Decimal("-500.00")
    assert normalized.postings[1].units.symbol == "USD"


def test_normalize_transaction_rejects_cost_price_symbol_mismatch() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
                cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                price=MoneyValue(amount=Decimal("150.00"), symbol="CHF"),
            ),
            PostingNormalizePayload(account="accounts/acc_two"),
        ],
    )

    with pytest.raises(ValidationError) as exc_info:
        ledger_service.normalize_transaction_payload(payload)

    assert exc_info.value.code == "cost_price_symbol_mismatch"


def test_normalize_transaction_expands_multi_symbol_weights() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-95.65"), symbol="CHF"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("20.00"), symbol="EUR"),
            ),
            PostingNormalizePayload(account="accounts/acc_three"),
        ],
    )

    normalized = ledger_service.normalize_transaction_payload(payload)

    assert len(normalized.postings) == 4
    inferred = normalized.postings[2:]
    assert [posting.account for posting in inferred] == ["accounts/acc_three", "accounts/acc_three"]
    assert inferred[0].units is not None and inferred[0].units == MoneyValue(
        amount=Decimal("95.65"), symbol="CHF"
    )
    assert inferred[1].units is not None and inferred[1].units == MoneyValue(
        amount=Decimal("-20.00"), symbol="EUR"
    )


def test_zero_weight_posting_does_not_create_ambiguity() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("0"), symbol="ESGV"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("89.35"), symbol="USD"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_three",
                units=MoneyValue(amount=Decimal("15.77"), symbol="USD"),
            ),
            PostingNormalizePayload(account="accounts/acc_four"),
        ],
    )

    normalized = ledger_service.normalize_transaction_payload(payload)

    inferred = normalized.postings[-1]
    assert inferred.units is not None
    assert inferred.units.amount == Decimal("-105.12")
    assert inferred.units.symbol == "USD"


def test_normalize_transaction_cost_wins_when_symbols_match() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
                cost=MoneyValue(amount=Decimal("100.00"), symbol="USD"),
                price=MoneyValue(amount=Decimal("150.00"), symbol="USD"),
            ),
            PostingNormalizePayload(account="accounts/acc_two"),
        ],
    )

    normalized = ledger_service.normalize_transaction_payload(payload)

    assert normalized.postings[1].units is not None
    assert normalized.postings[1].units.amount == Decimal("-500.00")
    assert normalized.postings[1].units.symbol == "USD"


def test_normalize_transaction_infers_missing_symbol_from_balancing_weight() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-160.00"), symbol="CHF"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=NormalizeMoneyValue(amount=Decimal("160.00"), symbol=None),
            ),
        ],
    )

    normalized = ledger_service.normalize_transaction_payload(payload)

    assert normalized.postings[1].units is not None
    assert normalized.postings[1].units.amount == Decimal("160.00")
    assert normalized.postings[1].units.symbol == "CHF"


def test_normalize_transaction_rejects_missing_symbol_with_cost() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-160.00"), symbol="CHF"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=NormalizeMoneyValue(amount=Decimal("160.00"), symbol=None),
                cost=MoneyValue(amount=Decimal("1.00"), symbol="CHF"),
            ),
        ],
    )

    with pytest.raises(ValidationError) as exc_info:
        ledger_service.normalize_transaction_payload(payload)

    assert exc_info.value.code == "missing_symbol_with_cost_or_price"


def test_normalize_transaction_rejects_missing_symbol_with_price() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-160.00"), symbol="CHF"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=NormalizeMoneyValue(amount=Decimal("160.00"), symbol=None),
                price=MoneyValue(amount=Decimal("1.00"), symbol="CHF"),
            ),
        ],
    )

    with pytest.raises(ValidationError) as exc_info:
        ledger_service.normalize_transaction_payload(payload)

    assert exc_info.value.code == "missing_symbol_with_cost_or_price"


def test_normalize_transaction_interpolates_missing_price_amount() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-22.80"), symbol="CHF"),
                price=MoneyValue(amount=Decimal("0.997999"), symbol="USD"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("1.30"), symbol="CHF"),
                price=NormalizePriceValue(symbol="USD"),
            ),
        ],
    )

    normalized = ledger_service.normalize_transaction_payload(payload)

    assert normalized.postings[1].price is not None
    assert normalized.postings[1].price.symbol == "USD"
    assert normalized.postings[1].price.amount == Decimal("17.50336707692307692307692308")


def test_normalize_transaction_rejects_multiple_missing_price_amounts_same_group() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-10.00"), symbol="CHF"),
                price=MoneyValue(amount=Decimal("1.00"), symbol="USD"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("6.00"), symbol="CHF"),
                price=NormalizePriceValue(symbol="USD"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_three",
                units=MoneyValue(amount=Decimal("4.00"), symbol="CHF"),
                price=NormalizePriceValue(symbol="USD"),
            ),
        ],
    )

    with pytest.raises(ValidationError) as exc_info:
        ledger_service.normalize_transaction_payload(payload)

    assert exc_info.value.code == "multiple_missing_price_amounts_in_group"


def test_normalize_transaction_allows_missing_price_amounts_in_different_groups() -> None:
    payload = TransactionNormalizeData(
        transaction_date=date(2026, 4, 19),
        postings=[
            PostingNormalizePayload(
                account="accounts/acc_one",
                units=MoneyValue(amount=Decimal("-10.00"), symbol="CHF"),
                price=MoneyValue(amount=Decimal("1.00"), symbol="USD"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_two",
                units=MoneyValue(amount=Decimal("6.00"), symbol="CHF"),
                price=NormalizePriceValue(symbol="USD"),
            ),
            PostingNormalizePayload(
                account="accounts/acc_three",
                units=MoneyValue(amount=Decimal("4.00"), symbol="CHF"),
                price=NormalizePriceValue(symbol="EUR"),
            ),
        ],
    )

    normalized = ledger_service.normalize_transaction_payload(payload)

    assert normalized.postings[1].price is not None
    assert normalized.postings[1].price.amount == Decimal("1.666666666666666666666666667")
    assert normalized.postings[2].price is not None
    assert normalized.postings[2].price.amount == Decimal("0")
