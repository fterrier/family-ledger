from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    CreatePriceRequest,
    ListPricesResponse,
    PriceResource,
    UpdatePriceRequest,
)
from family_ledger.db import get_db_session
from family_ledger.services import prices as prices_service
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


@router.get("/prices", response_model=ListPricesResponse)
def list_prices(
    session: DbSession,
    page_size: int | None = None,
    page_token: str | None = None,
) -> ListPricesResponse:
    return _call_service(
        prices_service.list_prices_page,
        session,
        page_size=page_size,
        page_token=page_token,
    )


@router.post(
    "/prices",
    response_model=PriceResource,
    status_code=status.HTTP_201_CREATED,
)
def create_price(request: CreatePriceRequest, session: DbSession) -> PriceResource:
    return _call_service(prices_service.create_price, session, request.price)


@router.get("/prices/{price:path}", response_model=PriceResource)
def get_price(price: str, session: DbSession) -> PriceResource:
    return _call_service(prices_service.get_price_by_name, session, price)


@router.patch("/prices/{price:path}", response_model=PriceResource)
def update_price(
    price: str,
    request: UpdatePriceRequest,
    session: DbSession,
) -> PriceResource:
    return _call_service(prices_service.update_price, session, price, request.price)
