from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    BalanceAssertionResource,
    CreateBalanceAssertionRequest,
    ListBalanceAssertionsResponse,
    UpdateBalanceAssertionRequest,
)
from family_ledger.db import get_db_session
from family_ledger.services import balance_assertions as balance_assertions_service
from family_ledger.services.errors import (
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)

router = APIRouter(dependencies=[Depends(require_api_token)])

DbSession = Annotated[Session, Depends(get_db_session)]


def _translate_service_error(error: ServiceError) -> HTTPException:
    if isinstance(error, ValidationError):
        status_code = status.HTTP_400_BAD_REQUEST
    elif isinstance(error, NotFoundError):
        status_code = status.HTTP_404_NOT_FOUND
    elif isinstance(error, ConflictError):
        status_code = status.HTTP_409_CONFLICT
    else:
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR

    return HTTPException(
        status_code=status_code,
        detail={
            "code": error.code,
            "message": error.message,
        },
    )


def _call_service(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ServiceError as error:
        raise _translate_service_error(error) from error


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
