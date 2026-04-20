from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.api.schemas import ImportMetadata, MoneyValue, PostingPayload, TransactionCreate
from family_ledger.models import Account, Base, Commodity
from family_ledger.services import ledger as ledger_service
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
