from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import CommodityCreate, CommodityResource, ListCommoditiesResponse
from family_ledger.models import Commodity
from family_ledger.services.errors import NotFoundError, commit_or_raise
from family_ledger.services.identifiers import generate_resource_name
from family_ledger.services.pagination import run_list_page
from family_ledger.services.update_mask import parse_update_mask
from family_ledger.services.validation import resource_name


def serialize_commodity(commodity: Commodity) -> CommodityResource:
    return CommodityResource.model_validate(commodity)


def list_commodities_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListCommoditiesResponse:
    commodities, next_page_token = run_list_page(
        session,
        select(Commodity).order_by(Commodity.symbol),
        page_size=page_size,
        page_token=page_token,
    )
    return ListCommoditiesResponse(
        commodities=[serialize_commodity(c) for c in commodities],
        next_page_token=next_page_token,
    )


def get_commodity_by_name(session: Session, commodity: str) -> CommodityResource:
    resource = resource_name("commodities", commodity)
    commodity_row = session.scalar(select(Commodity).where(Commodity.name == resource))
    if commodity_row is None:
        raise NotFoundError(code="commodity_not_found", message="Commodity not found")
    return serialize_commodity(commodity_row)


COMMODITY_UPDATE_FIELDS = ("symbol", "ticker", "entity_metadata")


def update_commodity(
    session: Session, commodity: str, payload: CommodityCreate, update_mask: str
) -> CommodityResource:
    mask = parse_update_mask(update_mask, COMMODITY_UPDATE_FIELDS)
    resource = resource_name("commodities", commodity)
    commodity_row = session.scalar(select(Commodity).where(Commodity.name == resource))
    if commodity_row is None:
        raise NotFoundError(code="commodity_not_found", message="Commodity not found")
    if "symbol" in mask:
        commodity_row.symbol = payload.symbol
    if "ticker" in mask:
        commodity_row.ticker = payload.ticker
    if "entity_metadata" in mask:
        commodity_row.entity_metadata = payload.entity_metadata
    commit_or_raise(session)
    session.refresh(commodity_row)
    return serialize_commodity(commodity_row)


def delete_commodity(session: Session, commodity: str) -> None:
    resource = resource_name("commodities", commodity)
    commodity_row = session.scalar(select(Commodity).where(Commodity.name == resource))
    if commodity_row is None:
        raise NotFoundError(code="commodity_not_found", message="Commodity not found")
    session.delete(commodity_row)
    commit_or_raise(session)


def create_commodity(session: Session, payload: CommodityCreate) -> CommodityResource:
    commodity = Commodity(
        name=generate_resource_name("commodities", "cmd"),
        symbol=payload.symbol,
        ticker=payload.ticker,
        entity_metadata=payload.entity_metadata,
    )
    session.add(commodity)
    commit_or_raise(session)
    session.refresh(commodity)
    return serialize_commodity(commodity)
