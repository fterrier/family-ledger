from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from family_ledger.api.schemas import (
    AccountResource,
    BalanceAssertionResource,
    CommodityResource,
    MoneyValue,
    PostingPayload,
    PriceResource,
    TransactionResource,
)
from family_ledger.db import SessionLocal
from family_ledger.models import Account, BalanceAssertion, Commodity, Price, Transaction
from family_ledger.services import ledger as ledger_service


def database_is_empty(session) -> bool:
    core_models = [Account, Commodity, Transaction, Price, BalanceAssertion]
    return all(session.scalar(select(model.id).limit(1)) is None for model in core_models)


def demo_accounts() -> list[AccountResource]:
    return [
        AccountResource(
            name="accounts/checking-family",
            ledger_name="Assets:Bank:Checking:Family",
            effective_start_date=date(2020, 1, 1),
        ),
        AccountResource(
            name="accounts/broker-usd",
            ledger_name="Assets:Broker:Cash:USD",
            effective_start_date=date(2020, 1, 1),
        ),
        AccountResource(
            name="accounts/expenses-uncategorized",
            ledger_name="Expenses:Uncategorized",
            effective_start_date=date(2020, 1, 1),
        ),
        AccountResource(
            name="accounts/expenses-food",
            ledger_name="Expenses:Food",
            effective_start_date=date(2020, 1, 1),
        ),
        AccountResource(
            name="accounts/income-salary",
            ledger_name="Income:Salary",
            effective_start_date=date(2020, 1, 1),
        ),
    ]


def create_accounts(session) -> None:
    accounts = demo_accounts()
    for account in accounts:
        ledger_service.create_account(session, account)


def demo_commodities() -> list[CommodityResource]:
    return [
        CommodityResource(name="commodities/chf", symbol="CHF"),
        CommodityResource(name="commodities/usd", symbol="USD"),
        CommodityResource(name="commodities/goog", symbol="GOOG"),
    ]


def create_commodities(session) -> None:
    commodities = demo_commodities()
    for commodity in commodities:
        ledger_service.create_commodity(session, commodity)


def demo_transactions() -> list[TransactionResource]:
    return [
        TransactionResource(
            name="transactions/salary-2026-04",
            transaction_date=date(2026, 4, 1),
            payee="Employer AG",
            narration="Monthly salary",
            postings=[
                PostingPayload(
                    account="accounts/checking-family",
                    units=MoneyValue(amount=Decimal("5000.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/income-salary",
                    units=MoneyValue(amount=Decimal("-5000.00"), symbol="CHF"),
                ),
            ],
        ),
        TransactionResource(
            name="transactions/groceries-2026-04-03",
            transaction_date=date(2026, 4, 3),
            payee="Migros",
            narration="Groceries",
            postings=[
                PostingPayload(
                    account="accounts/checking-family",
                    units=MoneyValue(amount=Decimal("-84.25"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/expenses-food",
                    units=MoneyValue(amount=Decimal("84.25"), symbol="CHF"),
                ),
            ],
        ),
        TransactionResource(
            name="transactions/card-payment-2026-04-05",
            transaction_date=date(2026, 4, 5),
            payee="Visa",
            narration="Card payment",
            postings=[
                PostingPayload(
                    account="accounts/checking-family",
                    units=MoneyValue(amount=Decimal("-42.10"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/expenses-uncategorized",
                    units=MoneyValue(amount=Decimal("42.10"), symbol="CHF"),
                ),
            ],
        ),
        TransactionResource(
            name="transactions/broker-transfer-2026-04-07",
            transaction_date=date(2026, 4, 7),
            payee="Broker",
            narration="Transfer to USD cash",
            postings=[
                PostingPayload(
                    account="accounts/checking-family",
                    units=MoneyValue(amount=Decimal("-920.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account="accounts/broker-usd",
                    units=MoneyValue(amount=Decimal("1000.00"), symbol="USD"),
                    price=MoneyValue(amount=Decimal("0.92"), symbol="CHF"),
                ),
            ],
        ),
    ]


def create_transactions(session) -> None:
    transactions = demo_transactions()
    for transaction in transactions:
        ledger_service.create_transaction(session, transaction)


def demo_prices() -> list[PriceResource]:
    return [
        PriceResource(
            name="prices/usd-chf-2026-04-07",
            price_date=date(2026, 4, 7),
            base_symbol="USD",
            quote=MoneyValue(amount=Decimal("0.92"), symbol="CHF"),
        )
    ]


def create_prices(session) -> None:
    prices = demo_prices()
    for price in prices:
        ledger_service.create_price(session, price)


def demo_balance_assertions() -> list[BalanceAssertionResource]:
    return [
        BalanceAssertionResource(
            name="balanceAssertions/checking-family-2026-04-10",
            assertion_date=date(2026, 4, 10),
            account="accounts/checking-family",
            amount=MoneyValue(amount=Decimal("3953.65"), symbol="CHF"),
        )
    ]


def create_balance_assertions(session) -> None:
    assertions = demo_balance_assertions()
    for assertion in assertions:
        ledger_service.create_balance_assertion(session, assertion)


def bootstrap_demo(session) -> None:
    if not database_is_empty(session):
        raise RuntimeError(
            "Demo bootstrap expects an empty database. "
            "Refusing to seed because data already exists."
        )

    create_accounts(session)
    create_commodities(session)
    create_transactions(session)
    create_prices(session)
    create_balance_assertions(session)


def main() -> None:
    with SessionLocal() as session:
        bootstrap_demo(session)

    print("Demo ledger bootstrap completed.")


if __name__ == "__main__":
    main()
