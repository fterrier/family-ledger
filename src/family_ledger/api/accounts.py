from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, status

from family_ledger.api._helpers import DbSession, _call_service
from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    AccountResource,
    CreateAccountRequest,
    ListAccountsResponse,
    PadResponse,
    UpdateAccountRequest,
)
from family_ledger.db import read_only_transaction
from family_ledger.services import account_balance as account_balance_service
from family_ledger.services import accounts as accounts_service

router = APIRouter(dependencies=[Depends(require_api_token)])


@router.get("/accounts", response_model=ListAccountsResponse)
def list_accounts(
    session: DbSession,
    page_size: int | None = None,
    page_token: str | None = None,
) -> ListAccountsResponse:
    return _call_service(
        accounts_service.list_accounts_page,
        session,
        page_size=page_size,
        page_token=page_token,
    )


@router.post(
    "/accounts",
    response_model=AccountResource,
    status_code=status.HTTP_201_CREATED,
)
def create_account(request: CreateAccountRequest, session: DbSession) -> AccountResource:
    return _call_service(accounts_service.create_account, session, request.account)


@router.get("/accounts/{account:path}:pad", response_model=PadResponse)
def pad_account(account: str, date: date, session: DbSession) -> PadResponse:
    with read_only_transaction(session):
        return _call_service(account_balance_service.compute_pad, session, account, date)


@router.get("/accounts/{account:path}", response_model=AccountResource)
def get_account(account: str, session: DbSession) -> AccountResource:
    return _call_service(accounts_service.get_account_by_name, session, account)


@router.patch("/accounts/{account:path}", response_model=AccountResource)
def update_account(
    account: str,
    request: UpdateAccountRequest,
    session: DbSession,
) -> AccountResource:
    return _call_service(accounts_service.update_account, session, account, request.account)
