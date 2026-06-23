from __future__ import annotations

from fastapi import APIRouter, Depends, status

from family_ledger.api._helpers import DbSession, _call_service
from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    CreatePriceRequest,
    ListPricesResponse,
    PriceResource,
    UpdatePriceRequest,
)
from family_ledger.services import prices as prices_service

router = APIRouter(dependencies=[Depends(require_api_token)])


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
