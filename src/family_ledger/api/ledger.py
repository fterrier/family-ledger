from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    AccountResource,
    BalanceAssertionResource,
    CommodityResource,
    CreateAccountRequest,
    CreateBalanceAssertionRequest,
    CreateCommodityRequest,
    CreatePriceRequest,
    CreateTransactionRequest,
    ListAccountsResponse,
    ListCommoditiesResponse,
    PriceResource,
    TransactionResource,
)
from family_ledger.db import get_db_session
from family_ledger.services import ledger as ledger_service

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db_session)]


@router.get("/accounts", response_model=ListAccountsResponse)
def list_accounts(session: DbSession) -> ListAccountsResponse:
    return ledger_service.list_accounts(session)


@router.post(
    "/accounts",
    response_model=AccountResource,
    status_code=status.HTTP_201_CREATED,
)
def create_account(request: CreateAccountRequest, session: DbSession) -> AccountResource:
    return ledger_service.create_account(session, request.account)


@router.get("/accounts/{account:path}", response_model=AccountResource)
def get_account(account: str, session: DbSession) -> AccountResource:
    return ledger_service.get_account_by_name(session, account)


@router.get("/commodities", response_model=ListCommoditiesResponse)
def list_commodities(session: DbSession) -> ListCommoditiesResponse:
    return ledger_service.list_commodities(session)


@router.post(
    "/commodities",
    response_model=CommodityResource,
    status_code=status.HTTP_201_CREATED,
)
def create_commodity(request: CreateCommodityRequest, session: DbSession) -> CommodityResource:
    return ledger_service.create_commodity(session, request.commodity)


@router.get("/commodities/{commodity:path}", response_model=CommodityResource)
def get_commodity(commodity: str, session: DbSession) -> CommodityResource:
    return ledger_service.get_commodity_by_name(session, commodity)


@router.post(
    "/transactions",
    response_model=TransactionResource,
    status_code=status.HTTP_201_CREATED,
)
def create_transaction(
    request: CreateTransactionRequest, session: DbSession
) -> TransactionResource:
    return ledger_service.create_transaction(session, request.transaction)


@router.get("/transactions/{transaction:path}", response_model=TransactionResource)
def get_transaction(transaction: str, session: DbSession) -> TransactionResource:
    return ledger_service.get_transaction_by_name(session, transaction)


@router.post(
    "/prices",
    response_model=PriceResource,
    status_code=status.HTTP_201_CREATED,
)
def create_price(request: CreatePriceRequest, session: DbSession) -> PriceResource:
    return ledger_service.create_price(session, request.price)


@router.get("/prices/{price:path}", response_model=PriceResource)
def get_price(price: str, session: DbSession) -> PriceResource:
    return ledger_service.get_price_by_name(session, price)


@router.post(
    "/balance-assertions",
    response_model=BalanceAssertionResource,
    status_code=status.HTTP_201_CREATED,
)
def create_balance_assertion(
    request: CreateBalanceAssertionRequest,
    session: DbSession,
) -> BalanceAssertionResource:
    return ledger_service.create_balance_assertion(session, request.balance_assertion)


@router.get(
    "/balance-assertions/{balance_assertion:path}",
    response_model=BalanceAssertionResource,
)
def get_balance_assertion(
    balance_assertion: str,
    session: DbSession,
) -> BalanceAssertionResource:
    return ledger_service.get_balance_assertion_by_name(session, balance_assertion)
