from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import ListPricesResponse, MoneyValue, PriceCreate, PriceResource
from family_ledger.models import Price
from family_ledger.services.errors import NotFoundError, commit_or_raise
from family_ledger.services.identifiers import generate_resource_name
from family_ledger.services.pagination import run_list_page
from family_ledger.services.validation import resource_name, validate_symbols_exist


def serialize_price(price: Price) -> PriceResource:
    return PriceResource(
        name=price.name,
        price_date=price.price_date,
        base_symbol=price.base_symbol,
        quote=MoneyValue(amount=price.price_per_unit, symbol=price.quote_symbol),
        entity_metadata=price.entity_metadata,
    )


def list_prices_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListPricesResponse:
    prices, next_page_token = run_list_page(
        session,
        select(Price).order_by(Price.price_date, Price.name),
        page_size=page_size,
        page_token=page_token,
    )
    return ListPricesResponse(
        prices=[serialize_price(p) for p in prices],
        next_page_token=next_page_token,
    )


def get_price_by_name(session: Session, price: str) -> PriceResource:
    resource = resource_name("prices", price)
    price_row = session.scalar(select(Price).where(Price.name == resource))
    if price_row is None:
        raise NotFoundError(code="price_not_found", message="Price not found")
    return serialize_price(price_row)


def create_price(session: Session, payload: PriceCreate) -> PriceResource:
    validate_symbols_exist(session, {payload.base_symbol, payload.quote.symbol})
    price = Price(
        name=generate_resource_name("prices", "prc"),
        price_date=payload.price_date,
        base_symbol=payload.base_symbol,
        quote_symbol=payload.quote.symbol,
        price_per_unit=payload.quote.amount,
        entity_metadata=payload.entity_metadata,
    )
    session.add(price)
    commit_or_raise(session)
    session.refresh(price)
    return serialize_price(price)


def update_price(session: Session, price: str, payload: PriceCreate) -> PriceResource:
    resource = resource_name("prices", price)
    price_row = session.scalar(select(Price).where(Price.name == resource))
    if price_row is None:
        raise NotFoundError(code="price_not_found", message="Price not found")
    validate_symbols_exist(session, {payload.base_symbol, payload.quote.symbol})
    price_row.price_date = payload.price_date
    price_row.base_symbol = payload.base_symbol
    price_row.quote_symbol = payload.quote.symbol
    price_row.price_per_unit = payload.quote.amount
    commit_or_raise(session)
    session.refresh(price_row)
    return serialize_price(price_row)
