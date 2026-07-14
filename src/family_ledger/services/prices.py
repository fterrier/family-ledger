from __future__ import annotations

from bisect import bisect_right
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import ListPricesResponse, MoneyValue, PriceCreate, PriceResource
from family_ledger.models import Price
from family_ledger.services.errors import NotFoundError, commit_or_raise
from family_ledger.services.identifiers import generate_resource_name
from family_ledger.services.pagination import run_list_page
from family_ledger.services.validation import resource_name, validate_symbols_exist


def _to_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


class PriceLookup:
    """Latest price on or before a date: direct pair, inverse pair, then a
    single intermediate hop (base -> X -> target).

    When several intermediates are available, the one with the freshest
    base-leg price wins (alphabetical order breaks ties). Loads only prices
    dated on or before ``latest`` (the newest conversion date the caller can
    ask for); inverse rates are computed on hit, not at load time. Shared by
    the reporting query executor and the transaction list's ``convert``
    view.
    """

    def __init__(self, session: Session, currencies: set[str], target: str, latest: date) -> None:
        self._target = target
        self._series: dict[tuple[str, str], tuple[list[date], list[Decimal]]] = {}
        self._neighbors: dict[str, set[str]] = {}
        if not currencies:
            return
        rows = session.execute(
            select(
                Price.base_symbol,
                Price.quote_symbol,
                Price.price_date,
                Price.price_per_unit,
            )
            .where(
                or_(
                    Price.base_symbol.in_(currencies),
                    Price.quote_symbol.in_(currencies),
                    Price.base_symbol == target,
                    Price.quote_symbol == target,
                )
            )
            .where(Price.price_date <= latest)
            .order_by(Price.price_date)
        ).all()
        for base, quote, price_date, rate in rows:
            dates, rates = self._series.setdefault((base, quote), ([], []))
            dates.append(price_date)
            rates.append(_to_decimal(rate))
            self._neighbors.setdefault(base, set()).add(quote)
            self._neighbors.setdefault(quote, set()).add(base)

    @property
    def target(self) -> str:
        return self._target

    def _pair(self, base: str, quote: str, on: date) -> tuple[Decimal, date] | None:
        entry = self._series.get((base, quote))
        if entry is not None:
            dates, rates = entry
            index = bisect_right(dates, on)
            if index:
                return rates[index - 1], dates[index - 1]
        entry = self._series.get((quote, base))
        if entry is not None:
            dates, rates = entry
            index = bisect_right(dates, on)
            if index:
                return Decimal(1) / rates[index - 1], dates[index - 1]
        return None

    def rate(self, base: str, on: date) -> Decimal | None:
        found = self._pair(base, self._target, on)
        if found is not None:
            return found[0]

        best: tuple[date, Decimal] | None = None
        for intermediate in sorted(self._neighbors.get(base, ())):
            if intermediate in (base, self._target):
                continue
            base_leg = self._pair(base, intermediate, on)
            if base_leg is None:
                continue
            target_leg = self._pair(intermediate, self._target, on)
            if target_leg is None:
                continue
            if best is None or base_leg[1] > best[0]:
                best = (base_leg[1], base_leg[0] * target_leg[0])
        return None if best is None else best[1]


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
