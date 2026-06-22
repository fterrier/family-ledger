from __future__ import annotations

from collections.abc import Generator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    BalanceAssertionCreate,
    MoneyValue,
    PostingPayload,
    TransactionCreate,
)
from family_ledger.models import Account, BalanceAssertion, Base, Commodity, Posting, Transaction
from family_ledger.services import account_balance
from family_ledger.services import balance_assertions as balance_assertions_service
from family_ledger.services import transactions as transactions_service
from family_ledger.services.errors import NotFoundError, ValidationError

# ---------------------------------------------------------------------------
# Session fixture — used only by compute_pad tests
# ---------------------------------------------------------------------------


@pytest.fixture
def session() -> Generator[Session, None, None]:
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)

    with Session(engine) as s:
        yield s


# ---------------------------------------------------------------------------
# Helpers for compute_balance_assertion_diffs (no DB needed)
# ---------------------------------------------------------------------------


def _mk_account(account_name: str) -> Account:
    return Account(account_name=account_name)


def _mk_tx(
    tx_date: date,
    postings_data: list[tuple[str, Decimal, str]],
    name: str = "tx_1",
) -> Transaction:
    tx = Transaction(transaction_date=tx_date, name=name)
    postings = []
    for acc_name, amount, symbol in postings_data:
        p = Posting(units_amount=amount, units_symbol=symbol)
        p.account = _mk_account(acc_name)
        postings.append(p)
    tx.postings = postings
    return tx


def _mk_ba(
    ba_date: date,
    account_name: str,
    amount: Decimal,
    symbol: str,
    name: str = "ba_1",
) -> BalanceAssertion:
    ba = BalanceAssertion(assertion_date=ba_date, name=name, amount=amount, symbol=symbol)
    ba.account = _mk_account(account_name)
    return ba


# ---------------------------------------------------------------------------
# Helpers for compute_pad (DB-backed)
# ---------------------------------------------------------------------------


def _make_account(session: Session, name: str, acct_name: str) -> Account:
    a = Account(name=name, account_name=acct_name, effective_start_date=date(2020, 1, 1))
    session.add(a)
    session.flush()
    return a


def _make_commodity(session: Session, name: str, symbol: str) -> Commodity:
    c = Commodity(name=name, symbol=symbol)
    session.add(c)
    session.flush()
    return c


def _seed_base(session: Session) -> tuple[Account, Account, Commodity]:
    checking = _make_account(session, "accounts/acc_chk", "Assets:Checking")
    equity = _make_account(session, "accounts/acc_eq", "Equity:Opening")
    usd = _make_commodity(session, "commodities/cmd_usd", "USD")
    return checking, equity, usd


def _add_transaction(
    session: Session,
    tx_date: date,
    postings: list[tuple[Account, Decimal, str]],
) -> None:
    transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=tx_date,
            postings=[
                PostingPayload(
                    account=acc.name,
                    units=MoneyValue(amount=amount, symbol=symbol),
                )
                for acc, amount, symbol in postings
            ],
        ),
    )


# ---------------------------------------------------------------------------
# compute_balance_assertion_diffs — pure function, no DB needed
# ---------------------------------------------------------------------------


def test_no_assertions_returns_empty() -> None:
    diffs = account_balance.compute_balance_assertion_diffs([], [])
    assert diffs == []


def test_zero_diff_when_balance_matches() -> None:
    txs = [_mk_tx(date(2026, 1, 1), [("Assets:Checking", Decimal("1000"), "USD")])]
    bas = [_mk_ba(date(2026, 1, 2), "Assets:Checking", Decimal("1000"), "USD")]

    diffs = account_balance.compute_balance_assertion_diffs(txs, bas)

    assert len(diffs) == 1
    assert diffs[0].diff == Decimal("0")
    assert diffs[0].actual == Decimal("1000")


def test_positive_diff_when_account_short() -> None:
    txs = [_mk_tx(date(2026, 1, 1), [("Assets:Checking", Decimal("100"), "USD")])]
    bas = [_mk_ba(date(2026, 1, 2), "Assets:Checking", Decimal("1000"), "USD")]

    diffs = account_balance.compute_balance_assertion_diffs(txs, bas)

    assert diffs[0].diff == Decimal("900")


def test_transactions_before_assertion_date_counted() -> None:
    txs = [_mk_tx(date(2026, 1, 1), [("Assets:Checking", Decimal("500"), "USD")])]
    bas = [_mk_ba(date(2026, 1, 2), "Assets:Checking", Decimal("500"), "USD")]

    diffs = account_balance.compute_balance_assertion_diffs(txs, bas)

    assert diffs[0].actual == Decimal("500")


def test_transactions_on_assertion_date_excluded() -> None:
    txs = [_mk_tx(date(2026, 1, 2), [("Assets:Checking", Decimal("500"), "USD")])]
    bas = [_mk_ba(date(2026, 1, 2), "Assets:Checking", Decimal("0"), "USD")]

    diffs = account_balance.compute_balance_assertion_diffs(txs, bas)

    assert diffs[0].actual == Decimal("0")


def test_descendant_balances_counted() -> None:
    txs = [_mk_tx(date(2026, 1, 1), [("Assets:Checking:Savings", Decimal("200"), "USD")])]
    bas = [_mk_ba(date(2026, 1, 2), "Assets:Checking", Decimal("200"), "USD")]

    diffs = account_balance.compute_balance_assertion_diffs(txs, bas)

    assert diffs[0].actual == Decimal("200")
    assert diffs[0].diff == Decimal("0")


def test_multiple_currencies_separate_diffs() -> None:
    bas = [
        _mk_ba(date(2026, 1, 2), "Assets:Checking", Decimal("500"), "USD", name="ba_usd"),
        _mk_ba(date(2026, 1, 2), "Assets:Checking", Decimal("200"), "CHF", name="ba_chf"),
    ]

    diffs = account_balance.compute_balance_assertion_diffs([], bas)

    symbols = {d.symbol for d in diffs}
    assert symbols == {"USD", "CHF"}
    assert all(d.actual == Decimal("0") for d in diffs)


def test_caller_controls_which_assertions_are_evaluated() -> None:
    # The pure function evaluates exactly the assertions it receives; filtering is the caller's job.
    bas = [_mk_ba(date(2026, 1, 2), "Assets:Checking", Decimal("0"), "USD")]

    diffs = account_balance.compute_balance_assertion_diffs([], bas)

    assert len(diffs) == 1
    assert diffs[0].account_name == "Assets:Checking"


def test_results_ordered_by_assertion_input_order() -> None:
    # The function preserves input order; callers must sort before passing.
    bas = [
        _mk_ba(date(2026, 1, 1), "Assets:Checking", Decimal("0"), "USD", name="ba_early"),
        _mk_ba(date(2026, 1, 3), "Assets:Checking", Decimal("0"), "USD", name="ba_late"),
    ]

    diffs = account_balance.compute_balance_assertion_diffs([], bas)

    assert [d.assertion_date for d in diffs] == [date(2026, 1, 1), date(2026, 1, 3)]


# ---------------------------------------------------------------------------
# compute_pad
# ---------------------------------------------------------------------------


def test_compute_pad_basic(session: Session) -> None:
    checking, equity, _ = _seed_base(session)
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("1000"), symbol="USD"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))

    assert len(result.entries) == 1
    assert result.entries[0].units.amount == Decimal("1000")
    assert result.entries[0].units.symbol == "USD"


def test_compute_pad_same_date_transaction(session: Session) -> None:
    checking, equity, _ = _seed_base(session)
    _add_transaction(
        session,
        date(2026, 1, 1),
        [(checking, Decimal("500"), "USD"), (equity, Decimal("-500"), "USD")],
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("1000"), symbol="USD"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))
    assert result.entries[0].units.amount == Decimal("500")


def test_compute_pad_next_day_transaction(session: Session) -> None:
    checking, equity, _ = _seed_base(session)
    _add_transaction(
        session,
        date(2026, 1, 2),
        [(checking, Decimal("500"), "USD"), (equity, Decimal("-500"), "USD")],
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 3),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("1000"), symbol="USD"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))
    assert result.entries[0].units.amount == Decimal("500")


def test_compute_pad_descendant_balances(session: Session) -> None:
    checking = _make_account(session, "accounts/acc_chk", "Assets:Checking")
    savings = _make_account(session, "accounts/acc_sav", "Assets:Checking:Savings")
    equity = _make_account(session, "accounts/acc_eq", "Equity:Opening")
    _make_commodity(session, "commodities/cmd_usd", "USD")
    _add_transaction(
        session,
        date(2026, 1, 1),
        [(savings, Decimal("200"), "USD"), (equity, Decimal("-200"), "USD")],
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("1000"), symbol="USD"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))
    assert result.entries[0].units.amount == Decimal("800")


def test_compute_pad_non_leaf_account(session: Session) -> None:
    parent = _make_account(session, "accounts/acc_par", "Assets:Bank")
    child = _make_account(session, "accounts/acc_chd", "Assets:Bank:Checking")
    equity = _make_account(session, "accounts/acc_eq", "Equity:Opening")
    _make_commodity(session, "commodities/cmd_usd", "USD")
    _add_transaction(
        session,
        date(2026, 1, 1),
        [(child, Decimal("300"), "USD"), (equity, Decimal("-300"), "USD")],
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=parent.name,
            amount=MoneyValue(amount=Decimal("1000"), symbol="USD"),
        ),
    )

    result = account_balance.compute_pad(session, parent.name, date(2026, 1, 1))
    assert result.entries[0].units.amount == Decimal("700")


def test_compute_pad_no_assertion_after_date(session: Session) -> None:
    checking, equity, _ = _seed_base(session)
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2025, 12, 31),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("1000"), symbol="USD"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))
    assert result.entries == []


def test_compute_pad_within_tolerance_omitted(session: Session) -> None:
    checking, equity, _ = _seed_base(session)
    _make_commodity(session, "commodities/cmd_chf", "CHF")
    _add_transaction(
        session,
        date(2026, 1, 1),
        [(checking, Decimal("999.999"), "CHF"), (equity, Decimal("-999.999"), "CHF")],
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("1000"), symbol="CHF"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))
    assert result.entries == []


def test_compute_pad_only_first_assertion_per_currency(session: Session) -> None:
    checking, equity, _ = _seed_base(session)
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("500"), symbol="USD"),
        ),
    )
    _add_transaction(
        session,
        date(2026, 1, 3),
        [(checking, Decimal("300"), "USD"), (equity, Decimal("-300"), "USD")],
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 4),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("1000"), symbol="USD"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))

    assert len(result.entries) == 1
    assert result.entries[0].assertion_date == date(2026, 1, 2)
    assert result.entries[0].units.amount == Decimal("500")


def test_compute_pad_multiple_currencies(session: Session) -> None:
    checking, equity, _ = _seed_base(session)
    _make_commodity(session, "commodities/cmd_chf", "CHF")
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("500"), symbol="USD"),
        ),
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("200"), symbol="CHF"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))

    assert len(result.entries) == 2
    symbols = {e.units.symbol for e in result.entries}
    assert symbols == {"USD", "CHF"}


def test_compute_pad_cost_tracked_raises(session: Session) -> None:
    portfolio = _make_account(session, "accounts/acc_pf", "Assets:Portfolio")
    cash = _make_account(session, "accounts/acc_cash", "Assets:Cash")
    _make_commodity(session, "commodities/cmd_goog", "GOOG")
    _make_commodity(session, "commodities/cmd_usd", "USD")
    transactions_service.create_transaction(
        session,
        TransactionCreate(
            transaction_date=date(2026, 1, 1),
            postings=[
                PostingPayload(
                    account=portfolio.name,
                    units=MoneyValue(amount=Decimal("5"), symbol="GOOG"),
                    cost=MoneyValue(amount=Decimal("100"), symbol="USD"),
                ),
                PostingPayload(
                    account=cash.name,
                    units=MoneyValue(amount=Decimal("-500"), symbol="USD"),
                ),
            ],
        ),
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=portfolio.name,
            amount=MoneyValue(amount=Decimal("7"), symbol="GOOG"),
        ),
    )

    with pytest.raises(ValidationError) as exc_info:
        account_balance.compute_pad(session, portfolio.name, date(2026, 1, 1))
    assert exc_info.value.code == "pad_cost_tracked_account"


def test_compute_pad_transaction_with_multiple_postings_to_same_account_counted_once(
    session: Session,
) -> None:
    checking, equity, usd = _seed_base(session)
    # Two postings to the same account in one transaction — the join would produce
    # duplicate rows; the transaction must appear exactly once in the balance calc.
    _add_transaction(
        session,
        date(2026, 1, 1),
        [
            (checking, Decimal("300"), "USD"),
            (checking, Decimal("200"), "USD"),
            (equity, Decimal("-500"), "USD"),
        ],
    )
    balance_assertions_service.create_balance_assertion(
        session,
        BalanceAssertionCreate(
            assertion_date=date(2026, 1, 2),
            account=checking.name,
            amount=MoneyValue(amount=Decimal("500"), symbol="USD"),
        ),
    )

    result = account_balance.compute_pad(session, checking.name, date(2026, 1, 1))

    assert result.entries == []


def test_compute_pad_unknown_account_raises(session: Session) -> None:
    with pytest.raises(NotFoundError):
        account_balance.compute_pad(session, "accounts/acc_missing", date(2026, 1, 1))
