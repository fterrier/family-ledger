from __future__ import annotations

from fastapi import APIRouter, Depends, status

from family_ledger.api._helpers import DbSession, _call_service
from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    BalanceAssertionResource,
    CreateBalanceAssertionRequest,
    ListBalanceAssertionsResponse,
    UpdateBalanceAssertionRequest,
)
from family_ledger.services import balance_assertions as balance_assertions_service

router = APIRouter(dependencies=[Depends(require_api_token)])


@router.get("/balance-assertions", response_model=ListBalanceAssertionsResponse)
def list_balance_assertions(
    session: DbSession,
    page_size: int | None = None,
    page_token: str | None = None,
) -> ListBalanceAssertionsResponse:
    return _call_service(
        balance_assertions_service.list_balance_assertions_page,
        session,
        page_size=page_size,
        page_token=page_token,
    )


@router.post(
    "/balance-assertions",
    response_model=BalanceAssertionResource,
    status_code=status.HTTP_201_CREATED,
)
def create_balance_assertion(
    request: CreateBalanceAssertionRequest,
    session: DbSession,
) -> BalanceAssertionResource:
    return _call_service(
        balance_assertions_service.create_balance_assertion,
        session,
        request.balance_assertion,
    )


@router.get(
    "/balance-assertions/{balance_assertion:path}",
    response_model=BalanceAssertionResource,
)
def get_balance_assertion(
    balance_assertion: str,
    session: DbSession,
) -> BalanceAssertionResource:
    return _call_service(
        balance_assertions_service.get_balance_assertion_by_name, session, balance_assertion
    )


@router.patch(
    "/balance-assertions/{balance_assertion:path}",
    response_model=BalanceAssertionResource,
)
def update_balance_assertion(
    balance_assertion: str,
    request: UpdateBalanceAssertionRequest,
    session: DbSession,
) -> BalanceAssertionResource:
    return _call_service(
        balance_assertions_service.update_balance_assertion,
        session,
        balance_assertion,
        request.balance_assertion,
    )


@router.delete(
    "/balance-assertions/{balance_assertion:path}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_balance_assertion(balance_assertion: str, session: DbSession) -> None:
    _call_service(balance_assertions_service.delete_balance_assertion, session, balance_assertion)
