from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session

from family_ledger.models import Account, Base, Posting, Transaction
from family_ledger.scripts.backfill_unbalanced_postings import (
    backfill_unbalanced_transaction_fillers,
)


@pytest.fixture
def engine():
    _engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(_engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(_engine)
    return _engine


@pytest.fixture
def session(engine) -> Generator[Session, None, None]:
    with Session(engine) as s:
        yield s


def make_account(session: Session, name: str, account_name: str) -> Account:
    account = Account(name=name, account_name=account_name, effective_start_date=date(2020, 1, 1))
    session.add(account)
    session.flush()
    return account


def make_transaction(session: Session, name: str, *, updated_at: int | None = None) -> Transaction:
    transaction = Transaction(
        name=name,
        transaction_date=date(2026, 1, 15),
        payee=None,
        narration=None,
    )
    if updated_at is not None:
        transaction.updated_at = updated_at
    session.add(transaction)
    session.flush()
    return transaction


def test_backfill_adds_filler_posting_for_single_leg_transaction(session: Session) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    transaction = make_transaction(session, "transactions/txn_legacy")
    transaction.postings.append(
        Posting(
            account=checking,
            posting_order=1,
            units_amount=Decimal("-42.50"),
            units_symbol="CHF",
        )
    )
    session.commit()

    count = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert count == 1
    reloaded = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_legacy")
    ).scalar_one()
    assert len(reloaded.postings) == 2
    filler = reloaded.postings[1]
    assert filler.account_id is None
    assert filler.units_amount == Decimal("42.50")
    assert filler.units_symbol == "CHF"
    assert filler.posting_order == 2


def test_backfill_leaves_already_balanced_transaction_untouched(session: Session) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    food = make_account(session, "accounts/acc_food", "Expenses:Food")
    transaction = make_transaction(session, "transactions/txn_balanced")
    transaction.postings.append(
        Posting(account=checking, posting_order=1, units_amount=Decimal("-10"), units_symbol="CHF")
    )
    transaction.postings.append(
        Posting(account=food, posting_order=2, units_amount=Decimal("10"), units_symbol="CHF")
    )
    session.commit()

    count = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert count == 0
    reloaded = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_balanced")
    ).scalar_one()
    assert len(reloaded.postings) == 2


def test_backfill_does_not_duplicate_when_accountless_posting_already_balances(
    session: Session,
) -> None:
    # Sums every posting including existing accountless ones (same "is
    # anything structurally missing" semantics as
    # compute_full_balance_residuals_for_payload) — a transaction that's
    # already fully balanced overall must not get a second, redundant filler.
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    transaction = make_transaction(session, "transactions/txn_already_filled")
    transaction.postings.append(
        Posting(account=checking, posting_order=1, units_amount=Decimal("-100"), units_symbol="CHF")
    )
    transaction.postings.append(
        Posting(account=None, posting_order=2, units_amount=Decimal("100"), units_symbol="CHF")
    )
    session.commit()

    count = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert count == 0
    reloaded = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_already_filled")
    ).scalar_one()
    assert len(reloaded.postings) == 2


def test_backfill_adds_one_filler_per_unbalanced_symbol(session: Session) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    transaction = make_transaction(session, "transactions/txn_multi_symbol")
    transaction.postings.append(
        Posting(account=checking, posting_order=1, units_amount=Decimal("-10"), units_symbol="CHF")
    )
    transaction.postings.append(
        Posting(account=checking, posting_order=2, units_amount=Decimal("-20"), units_symbol="USD")
    )
    session.commit()

    count = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert count == 1
    reloaded = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_multi_symbol")
    ).scalar_one()
    assert len(reloaded.postings) == 4
    fillers = {p.units_symbol: p.units_amount for p in reloaded.postings[2:]}
    assert fillers == {"CHF": Decimal("10"), "USD": Decimal("20")}


def test_backfill_uses_cost_adjusted_weight(session: Session) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    brokerage = make_account(session, "accounts/acc_brokerage", "Assets:Brokerage")
    transaction = make_transaction(session, "transactions/txn_cost")
    transaction.postings.append(
        Posting(
            account=checking, posting_order=1, units_amount=Decimal("-1000"), units_symbol="CHF"
        )
    )
    # 5 units at cost 200 CHF/unit = 1000 CHF weight — already balances the
    # -1000 CHF leg above even though its own units_symbol is a share count.
    transaction.postings.append(
        Posting(
            account=brokerage,
            posting_order=2,
            units_amount=Decimal("5"),
            units_symbol="VTI",
            cost_per_unit=Decimal("200"),
            cost_symbol="CHF",
        )
    )
    session.commit()

    count = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert count == 0
    reloaded = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_cost")
    ).scalar_one()
    assert len(reloaded.postings) == 2


def test_backfill_adds_cost_adjusted_filler_for_unbalanced_cost_transaction(
    session: Session,
) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    brokerage = make_account(session, "accounts/acc_brokerage", "Assets:Brokerage")
    transaction = make_transaction(session, "transactions/txn_cost_unbalanced")
    transaction.postings.append(
        Posting(
            account=checking, posting_order=1, units_amount=Decimal("-1000"), units_symbol="CHF"
        )
    )
    # 4 units at cost 200 CHF/unit = 800 CHF weight — leaves a 200 CHF gap,
    # in the *weight* currency (CHF), not the posting's own units_symbol (VTI).
    transaction.postings.append(
        Posting(
            account=brokerage,
            posting_order=2,
            units_amount=Decimal("4"),
            units_symbol="VTI",
            cost_per_unit=Decimal("200"),
            cost_symbol="CHF",
        )
    )
    session.commit()

    count = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert count == 1
    reloaded = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_cost_unbalanced")
    ).scalar_one()
    assert len(reloaded.postings) == 3
    filler = reloaded.postings[2]
    assert filler.account_id is None
    assert filler.units_amount == Decimal("200")
    assert filler.units_symbol == "CHF"


def test_backfill_handles_mix_of_multi_symbol_and_cost_price_postings(session: Session) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    brokerage = make_account(session, "accounts/acc_brokerage", "Assets:Brokerage")
    transaction = make_transaction(session, "transactions/txn_mixed")
    # CHF leg, unbalanced by 30.
    transaction.postings.append(
        Posting(account=checking, posting_order=1, units_amount=Decimal("-100"), units_symbol="CHF")
    )
    transaction.postings.append(
        Posting(account=checking, posting_order=2, units_amount=Decimal("70"), units_symbol="CHF")
    )
    # USD leg via cost/price, unbalanced by 15 USD of weight.
    transaction.postings.append(
        Posting(account=checking, posting_order=3, units_amount=Decimal("-50"), units_symbol="USD")
    )
    transaction.postings.append(
        Posting(
            account=brokerage,
            posting_order=4,
            units_amount=Decimal("7"),
            units_symbol="VTI",
            cost_per_unit=Decimal("5"),
            cost_symbol="USD",
        )
    )
    session.commit()

    count = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert count == 1
    reloaded = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_mixed")
    ).scalar_one()
    assert len(reloaded.postings) == 6
    fillers = {p.units_symbol: p.units_amount for p in reloaded.postings[4:]}
    assert fillers == {"CHF": Decimal("30"), "USD": Decimal("15")}
    assert all(p.account_id is None for p in reloaded.postings[4:])


def test_backfill_within_tolerance_adds_nothing(session: Session) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    food = make_account(session, "accounts/acc_food", "Expenses:Food")
    transaction = make_transaction(session, "transactions/txn_within_tolerance")
    # Test ledger config sets CHF tolerance to 0.01 (see tests/conftest.py) —
    # a 0.001 residual is within it, so nothing should be added.
    transaction.postings.append(
        Posting(
            account=checking, posting_order=1, units_amount=Decimal("-10.000"), units_symbol="CHF"
        )
    )
    transaction.postings.append(
        Posting(account=food, posting_order=2, units_amount=Decimal("9.999"), units_symbol="CHF")
    )
    session.commit()

    count = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert count == 0


def test_backfill_bumps_updated_at_only_for_backfilled_transactions(session: Session) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    food = make_account(session, "accounts/acc_food", "Expenses:Food")

    unbalanced = make_transaction(session, "transactions/txn_a", updated_at=1000)
    unbalanced.postings.append(
        Posting(account=checking, posting_order=1, units_amount=Decimal("-10"), units_symbol="CHF")
    )
    balanced = make_transaction(session, "transactions/txn_b", updated_at=1000)
    balanced.postings.append(
        Posting(account=checking, posting_order=1, units_amount=Decimal("-10"), units_symbol="CHF")
    )
    balanced.postings.append(
        Posting(account=food, posting_order=2, units_amount=Decimal("10"), units_symbol="CHF")
    )
    session.commit()

    backfill_unbalanced_transaction_fillers(session)
    session.commit()

    reloaded_a = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_a")
    ).scalar_one()
    reloaded_b = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_b")
    ).scalar_one()
    assert reloaded_a.updated_at > 1000
    assert reloaded_b.updated_at == 1000


def test_backfill_is_idempotent_when_run_twice(session: Session) -> None:
    checking = make_account(session, "accounts/acc_checking", "Assets:Bank:Checking")
    transaction = make_transaction(session, "transactions/txn_legacy")
    transaction.postings.append(
        Posting(
            account=checking, posting_order=1, units_amount=Decimal("-42.50"), units_symbol="CHF"
        )
    )
    session.commit()

    first = backfill_unbalanced_transaction_fillers(session)
    session.commit()
    second = backfill_unbalanced_transaction_fillers(session)
    session.commit()

    assert first == 1
    assert second == 0
    reloaded = session.execute(
        select(Transaction).where(Transaction.name == "transactions/txn_legacy")
    ).scalar_one()
    assert len(reloaded.postings) == 2
