"""Shared in-memory ledger builder for the query-engine test suites."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from family_ledger.models import Account, Base, Posting, Price, Transaction

# (transaction date, [(account name, amount, symbol), ...])
LedgerRows = list[tuple[str, list[tuple[str, str, str]]]]

# Standard ledger shared by the compiler and executor suites.
# Assets:Checking:ZKB subtree CHF deltas: May +1000, Jul +4800, Aug -1800;
# Assets:Checking:ZKB:Sub USD delta: Aug +50.
# Expenses: Groceries Jul 200 / Aug 300, Rent Aug 1500.
STANDARD_TRANSACTIONS: LedgerRows = [
    ("2025-05-10", [("Assets:Checking:ZKB", "1000", "CHF"), ("Equity:Opening", "-1000", "CHF")]),
    ("2025-07-05", [("Assets:Checking:ZKB", "5000", "CHF"), ("Income:Salary", "-5000", "CHF")]),
    ("2025-07-20", [("Expenses:Groceries", "200", "CHF"), ("Assets:Checking:ZKB", "-200", "CHF")]),
    ("2025-08-03", [("Expenses:Groceries", "300", "CHF"), ("Assets:Checking:ZKB", "-300", "CHF")]),
    ("2025-08-15", [("Assets:Checking:ZKB:Sub", "50", "USD"), ("Equity:Opening", "-50", "USD")]),
    ("2025-08-20", [("Expenses:Rent", "1500", "CHF"), ("Assets:Checking:ZKB", "-1500", "CHF")]),
]

# Proves the subtree boundary: ZKBX must never match the ZKB subtree.
ZKBX_TRANSACTION = (
    "2025-09-01",
    [("Assets:Checking:ZKBX", "999", "CHF"), ("Equity:Opening", "-999", "CHF")],
)

STANDARD_PRICES: tuple[tuple[str, str, str, str], ...] = (
    ("2025-07-10", "USD", "CHF", "0.85"),
    ("2025-08-10", "USD", "CHF", "0.80"),
)


def build_session(
    transactions: LedgerRows,
    prices: tuple[tuple[str, str, str, str], ...] = (),
) -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine)

    accounts: dict[str, Account] = {}
    account_names = sorted({acc for _, postings in transactions for acc, _, _ in postings})
    for index, account_name in enumerate(account_names):
        accounts[account_name] = Account(
            name=f"accounts/acc-{index}",
            account_name=account_name,
            effective_start_date=date(2020, 1, 1),
        )
        session.add(accounts[account_name])

    for tx_index, (tx_date, postings) in enumerate(transactions):
        tx = Transaction(
            name=f"transactions/txn-{tx_index}",
            transaction_date=date.fromisoformat(tx_date),
        )
        tx.postings = [
            Posting(
                account=accounts[account_name],
                posting_order=posting_index,
                units_amount=Decimal(amount),
                units_symbol=symbol,
            )
            for posting_index, (account_name, amount, symbol) in enumerate(postings)
        ]
        session.add(tx)

    for price_index, (price_date, base, quote, rate) in enumerate(prices):
        session.add(
            Price(
                name=f"prices/price-{price_index}",
                price_date=date.fromisoformat(price_date),
                base_symbol=base,
                quote_symbol=quote,
                price_per_unit=Decimal(rate),
            )
        )

    session.commit()
    return session
