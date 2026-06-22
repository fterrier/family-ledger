from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    CommodityResource,
    CreateCommodityRequest,
    ListCommoditiesResponse,
    UpdateCommodityRequest,
)
from family_ledger.db import get_db_session
from family_ledger.services import commodities as commodities_service
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


@router.get("/commodities", response_model=ListCommoditiesResponse)
def list_commodities(
    session: DbSession,
    page_size: int | None = None,
    page_token: str | None = None,
) -> ListCommoditiesResponse:
    return _call_service(
        commodities_service.list_commodities_page,
        session,
        page_size=page_size,
        page_token=page_token,
    )


@router.post(
    "/commodities",
    response_model=CommodityResource,
    status_code=status.HTTP_201_CREATED,
)
def create_commodity(request: CreateCommodityRequest, session: DbSession) -> CommodityResource:
    return _call_service(commodities_service.create_commodity, session, request.commodity)


@router.get("/commodities/{commodity:path}", response_model=CommodityResource)
def get_commodity(commodity: str, session: DbSession) -> CommodityResource:
    return _call_service(commodities_service.get_commodity_by_name, session, commodity)


@router.patch("/commodities/{commodity:path}", response_model=CommodityResource)
def update_commodity(
    commodity: str,
    request: UpdateCommodityRequest,
    session: DbSession,
) -> CommodityResource:
    return _call_service(
        commodities_service.update_commodity, session, commodity, request.commodity
    )


@router.delete("/commodities/{commodity:path}", status_code=status.HTTP_204_NO_CONTENT)
def delete_commodity(commodity: str, session: DbSession) -> None:
    _call_service(commodities_service.delete_commodity, session, commodity)
