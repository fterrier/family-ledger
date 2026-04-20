from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from family_ledger.api.schemas import (
    AccountCreate,
    BalanceAssertionCreate,
    CommodityCreate,
    MoneyValue,
    PostingPayload,
    PriceCreate,
    TransactionCreate,
)
from family_ledger.db import SessionLocal
from family_ledger.models import Account, BalanceAssertion, Commodity, Price, Transaction
from family_ledger.services import ledger as ledger_service


def database_is_empty(session) -> bool:
    core_models = [Account, Commodity, Transaction, Price, BalanceAssertion]
    return all(session.scalar(select(model.id).limit(1)) is None for model in core_models)


def demo_accounts() -> dict[str, AccountCreate]:
    return {
        "checking": AccountCreate(
            account_name="Assets:Bank:Checking:Family",
            effective_start_date=date(2020, 1, 1),
        ),
        "broker_usd": AccountCreate(
            account_name="Assets:Broker:Cash:USD",
            effective_start_date=date(2020, 1, 1),
        ),
        "expenses_uncategorized": AccountCreate(
            account_name="Expenses:Uncategorized",
            effective_start_date=date(2020, 1, 1),
        ),
        "expenses_food": AccountCreate(
            account_name="Expenses:Food",
            effective_start_date=date(2020, 1, 1),
        ),
        "income_salary": AccountCreate(
            account_name="Income:Salary",
            effective_start_date=date(2020, 1, 1),
        ),
    }


def create_accounts(session) -> dict[str, str]:
    created_accounts = {}
    for alias, account in demo_accounts().items():
        created_accounts[alias] = ledger_service.create_account(session, account).name
    return created_accounts


def demo_commodities() -> list[CommodityCreate]:
    return [
        CommodityCreate(symbol="CHF"),
        CommodityCreate(symbol="USD"),
        CommodityCreate(symbol="GOOG"),
    ]


def create_commodities(session) -> None:
    commodities = demo_commodities()
    for commodity in commodities:
        ledger_service.create_commodity(session, commodity)


def demo_transactions(accounts: dict[str, str]) -> list[TransactionCreate]:
    return [
        TransactionCreate(
            transaction_date=date(2026, 4, 1),
            payee="Employer AG",
            narration="Monthly salary",
            postings=[
                PostingPayload(
                    account=accounts["checking"],
                    units=MoneyValue(amount=Decimal("5000.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account=accounts["income_salary"],
                    units=MoneyValue(amount=Decimal("-5000.00"), symbol="CHF"),
                ),
            ],
        ),
        TransactionCreate(
            transaction_date=date(2026, 4, 3),
            payee="Migros",
            narration="Groceries",
            postings=[
                PostingPayload(
                    account=accounts["checking"],
                    units=MoneyValue(amount=Decimal("-84.25"), symbol="CHF"),
                ),
                PostingPayload(
                    account=accounts["expenses_food"],
                    units=MoneyValue(amount=Decimal("84.25"), symbol="CHF"),
                ),
            ],
        ),
        TransactionCreate(
            transaction_date=date(2026, 4, 5),
            payee="Visa",
            narration="Card payment",
            postings=[
                PostingPayload(
                    account=accounts["checking"],
                    units=MoneyValue(amount=Decimal("-42.10"), symbol="CHF"),
                ),
                PostingPayload(
                    account=accounts["expenses_uncategorized"],
                    units=MoneyValue(amount=Decimal("42.10"), symbol="CHF"),
                ),
            ],
        ),
        TransactionCreate(
            transaction_date=date(2026, 4, 7),
            payee="Broker",
            narration="Transfer to USD cash",
            postings=[
                PostingPayload(
                    account=accounts["checking"],
                    units=MoneyValue(amount=Decimal("-920.00"), symbol="CHF"),
                ),
                PostingPayload(
                    account=accounts["broker_usd"],
                    units=MoneyValue(amount=Decimal("1000.00"), symbol="USD"),
                    price=MoneyValue(amount=Decimal("0.92"), symbol="CHF"),
                ),
            ],
        ),
    ]


def create_transactions(session, accounts: dict[str, str]) -> None:
    transactions = demo_transactions(accounts)
    for transaction in transactions:
        ledger_service.create_transaction(session, transaction)


def demo_prices() -> list[PriceCreate]:
    return [
        PriceCreate(
            price_date=date(2026, 4, 7),
            base_symbol="USD",
            quote=MoneyValue(amount=Decimal("0.92"), symbol="CHF"),
        )
    ]


def create_prices(session) -> None:
    prices = demo_prices()
    for price in prices:
        ledger_service.create_price(session, price)


def demo_balance_assertions(accounts: dict[str, str]) -> list[BalanceAssertionCreate]:
    return [
        BalanceAssertionCreate(
            assertion_date=date(2026, 4, 10),
            account=accounts["checking"],
            amount=MoneyValue(amount=Decimal("3953.65"), symbol="CHF"),
        )
    ]


def create_balance_assertions(session, accounts: dict[str, str]) -> None:
    assertions = demo_balance_assertions(accounts)
    for assertion in assertions:
        ledger_service.create_balance_assertion(session, assertion)


def bootstrap_demo(session) -> None:
    if not database_is_empty(session):
        raise RuntimeError(
            "Demo bootstrap expects an empty database. "
            "Refusing to seed because data already exists."
        )

    accounts = create_accounts(session)
    create_commodities(session)
    create_transactions(session, accounts)
    create_prices(session)
    create_balance_assertions(session, accounts)


def main() -> None:
    with SessionLocal() as session:
        bootstrap_demo(session)

    print("Demo ledger bootstrap completed.")


if __name__ == "__main__":
    main()
