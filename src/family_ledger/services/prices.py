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


def _latest(dates: list[date], rates: list[Decimal], on: date) -> tuple[Decimal, date] | None:
    """Latest (rate, date) on or before ``on``, taken literally — including
    0. Commodity/Price have no field distinguishing a currency from a
    security, so PriceLookup and ValuePriceLookup agree: a stored 0 is real
    information (a total loss, a delisting), not degenerate data to skip
    past."""
    index = bisect_right(dates, on)
    return (rates[index - 1], dates[index - 1]) if index else None


class PriceLookup:
    """Latest price on or before a date: direct pair, then a single
    intermediate hop (base -> X -> target) — a price must be recorded in
    the direction it's needed; no inverse-pair fallback.

    When several intermediates are available, the one with the freshest
    base-leg price wins (alphabetical order breaks ties). Loads only prices
    dated on or before ``latest`` (the newest conversion date the caller can
    ask for). Shared by the reporting query executor and the transaction
    list's ``convert`` view.
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
            # base_symbol covers direct pairs and first-hop legs (base ->
            # intermediate); quote_symbol == target covers direct pairs and
            # second-hop legs (intermediate -> target). No inversion, so a
            # row where only quote_symbol is in currencies (or only
            # base_symbol == target) can never match any lookup _pair does
            # — fetching those would just be dead weight.
            .where(or_(Price.base_symbol.in_(currencies), Price.quote_symbol == target))
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
        return None if entry is None else _latest(*entry, on)

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


class ValuePriceLookup:
    """Latest *direct* price for specific (base, quote) pairs, as of a date —
    a single non-chained hop, unlike PriceLookup's multi-hop FX resolution
    (both agree on everything else: no inversion, a stored 0 used literally
    — see PriceLookup's docstring and _latest).

    Mirrors beancount's get_value(): a position revalues only against a
    price quoted in its own value_currency (cost, else price currency) —
    a price recorded in some other currency is not a valid substitute, even
    if one exists. Used by the reporting query executor's value().
    """

    def __init__(self, session: Session, symbols: set[str], latest: date) -> None:
        self._series: dict[tuple[str, str], tuple[list[date], list[Decimal]]] = {}
        if not symbols:
            return
        rows = session.execute(
            select(
                Price.base_symbol,
                Price.quote_symbol,
                Price.price_date,
                Price.price_per_unit,
            )
            .where(Price.base_symbol.in_(symbols))
            .where(Price.price_date <= latest)
            .order_by(Price.price_date)
        ).all()
        for base, quote, price_date, rate in rows:
            dates, rates = self._series.setdefault((base, quote), ([], []))
            dates.append(price_date)
            rates.append(_to_decimal(rate))

    def price(self, base: str, quote: str, on: date) -> Decimal | None:
        entry = self._series.get((base, quote))
        if entry is None:
            return None
        found = _latest(*entry, on)
        return found[0] if found is not None else None


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


def delete_price(session: Session, price: str) -> None:
    resource = resource_name("prices", price)
    price_row = session.scalar(select(Price).where(Price.name == resource))
    if price_row is None:
        raise NotFoundError(code="price_not_found", message="Price not found")
    session.delete(price_row)
    commit_or_raise(session)


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
