"""Executor for the BQL-subset reporting query language.

Runs the compiled selects and assembles the client-facing
:class:`family_ledger.api.schemas.QueryLedgerResponse` per
docs/specs/reporting-query.md:

- SQL rows are per (group keys..., currency); the response has one row per
  group-key combination, with currencies folded into inventory/amount cells
- ``last(balance)`` deltas are accumulated on top of the ``OPEN ON`` seed;
  every returned bucket carries the full inventory of all currencies seen
- ``convert()`` resolves prices at the explicit date, the bucket end date,
  or today; latest price on or before that date wins, with the inverse pair
  and then a single intermediate hop (base -> X -> target) as fallbacks;
  missing prices produce ``null`` cells plus warnings
- cells are serialized JSON-ready (decimals as strings, dates as ISO)
"""

from __future__ import annotations

import calendar
from bisect import bisect_right
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.exc import DataError
from sqlalchemy.orm import Session

from family_ledger.api.schemas import QueryColumn, QueryLedgerResponse, QueryWarning
from family_ledger.models import Price
from family_ledger.services.errors import ValidationError
from family_ledger.services.query.compiler import CompiledQuery, PostPlan, compile_query
from family_ledger.services.query.parser import parse
from family_ledger.services.transaction_balancing import decimal_to_string

MAX_QUERY_LENGTH = 10_000
MAX_RESULT_ROWS = 10_000

_FOLDED_TYPES = ("inventory", "amount")


def _to_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _serialize_scalar(value: Any, cell_type: str) -> Any:
    if value is None:
        return None
    if cell_type == "date":
        return value.isoformat()
    if cell_type == "decimal":
        return decimal_to_string(_to_decimal(value))
    if cell_type == "int":
        return int(value)
    return value


def _serialize_inventory(balances: dict[str, Decimal]) -> list[dict[str, str]]:
    return [
        {"number": decimal_to_string(value), "currency": currency}
        for currency, value in sorted(balances.items())
        if value != 0
    ]


def _bucket_key_for_date(
    target: date, group_key_buckets: tuple[str | None, ...]
) -> tuple[Any, ...] | None:
    """Decomposes a date into the (year, month, day) tuple a bucketed
    running-balance query would have grouped it into. Returns None if any
    group key isn't a date bucket (running_balance already requires
    buckets-only grouping, so this is only a defensive guard)."""
    values: list[int] = []
    for bucket in group_key_buckets:
        if bucket == "year":
            values.append(target.year)
        elif bucket == "month":
            values.append(target.month)
        elif bucket == "day":
            values.append(target.day)
        else:
            return None
    return tuple(values)


def _bucket_end(key: tuple[Any, ...], buckets: tuple[str | None, ...]) -> date | None:
    parts = {
        bucket: int(value) for bucket, value in zip(buckets, key, strict=True) if bucket is not None
    }
    if "year" not in parts:
        return None
    year = parts["year"]
    if "month" in parts and "day" in parts:
        return date(year, parts["month"], parts["day"])
    if "month" in parts:
        month = parts["month"]
        return date(year, month, calendar.monthrange(year, month)[1])
    return date(year, 12, 31)


class _PriceLookup:
    """Latest price on or before a date: direct pair, inverse pair, then a
    single intermediate hop (base -> X -> target).

    When several intermediates are available, the one with the freshest
    base-leg price wins (alphabetical order breaks ties). Loads only prices
    dated on or before ``latest`` (the newest conversion date the query can
    ask for); inverse rates are computed on hit, not at load time.
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


def _execute(session: Session, statement: Any) -> Any:
    """Backstop: user input the compiler could not fully validate (e.g. regex
    syntax the database dialect rejects) must surface as a 400, not a 500."""
    try:
        return session.execute(statement)
    # Only DataError: it is the one class client input can trigger (e.g.
    # Postgres rejecting a dialect-specific regex). ProgrammingError would
    # mean the compiler built a bad statement — that must stay a 500.
    except DataError as exc:
        raise ValidationError(
            code="query_validation_error",
            message=f"query failed to execute: {exc.orig}",
        ) from exc


def execute_query(session: Session, text: str) -> QueryLedgerResponse:
    if len(text) > MAX_QUERY_LENGTH:
        raise ValidationError(
            code="query_parse_error",
            message=f"query exceeds {MAX_QUERY_LENGTH} characters",
        )

    compiled = compile_query(parse(text))
    raw = _execute(session, compiled.select.limit(MAX_RESULT_ROWS + 1)).all()
    if len(raw) > MAX_RESULT_ROWS:
        raise ValidationError(
            code="query_result_too_large",
            message=f"query returned more than {MAX_RESULT_ROWS} rows",
        )

    post = compiled.post
    if not post.is_aggregate:
        rows = [
            [
                _serialize_scalar(value, column.type)
                for value, column in zip(row, post.columns, strict=True)
            ]
            for row in raw
        ]
        return QueryLedgerResponse(columns=_columns(post), rows=rows, warnings=[])
    return _assemble_aggregate(session, compiled, raw)


def _columns(post: PostPlan) -> list[QueryColumn]:
    return [QueryColumn(name=column.name, type=column.type) for column in post.columns]


def _assemble_aggregate(
    session: Session, compiled: CompiledQuery, raw: list[Any]
) -> QueryLedgerResponse:
    post = compiled.post
    key_count = len(post.group_keys)
    folds = any(column.type in _FOLDED_TYPES for column in post.columns)

    # Fold SQL rows into one entry per group-key combination, preserving the
    # SQL ordering (group keys ascending). Values are per-currency Decimal
    # dicts when the query aggregates position/balance, plain scalars
    # otherwise (count).
    order: list[tuple[Any, ...]] = []
    per_key: dict[tuple[Any, ...], Any] = {}
    for row in raw:
        key = tuple(row[:key_count])
        if key not in per_key:
            order.append(key)
            per_key[key] = {} if folds else row[key_count]
        if folds:
            per_key[key][row[key_count]] = _to_decimal(row[key_count + 1])

    if post.running_balance:
        balances: dict[str, Decimal] = {}
        if compiled.seed_select is not None:
            balances = {
                currency: _to_decimal(total)
                for currency, total in _execute(session, compiled.seed_select).all()
            }
        # An account can be dormant (zero postings) inside the queried
        # window while still holding a nonzero opening balance. Without a
        # synthetic bucket here, `order` would stay empty and a real,
        # nonzero balance would be reported as "no data" instead of flat.
        if not order and balances and post.open_on is not None:
            synthetic_key = _bucket_key_for_date(post.open_on, post.group_key_buckets)
            if synthetic_key is not None:
                order.append(synthetic_key)
                per_key[synthetic_key] = {}
        for key in order:
            for currency, delta in per_key[key].items():
                balances[currency] = balances.get(currency, Decimal(0)) + delta
            per_key[key] = dict(balances)

    warnings: list[QueryWarning] = []
    cells: dict[tuple[Any, ...], Any] = {}
    if not folds:
        aggregate_column = next(c for c in post.columns if c.name not in post.group_keys)
        for key in order:
            cells[key] = _serialize_scalar(per_key[key], aggregate_column.type)
    elif post.conversion is None:
        for key in order:
            cells[key] = _serialize_inventory(per_key[key])
    else:
        conversion_dates = {
            key: post.conversion.at or _bucket_end(key, post.group_key_buckets) or date.today()
            for key in order
        }
        target = post.conversion.target_currency
        currencies = {
            currency
            for balances in per_key.values()
            for currency, value in balances.items()
            if currency != target and value != 0
        }
        lookup = _PriceLookup(
            session,
            currencies,
            target,
            latest=max(conversion_dates.values(), default=date.today()),
        )
        warned: set[tuple[str, date]] = set()
        for key in order:
            cells[key] = _convert_balances(
                per_key[key], target, conversion_dates[key], lookup, warnings, warned
            )

    key_index = {name: index for index, name in enumerate(post.group_keys)}
    rows: list[list[Any]] = []
    for key in order:
        rows.append(
            [
                _serialize_scalar(key[key_index[column.name]], column.type)
                if column.name in key_index
                else cells[key]
                for column in post.columns
            ]
        )
    return QueryLedgerResponse(columns=_columns(post), rows=rows, warnings=warnings)


def _convert_balances(
    balances: dict[str, Decimal],
    target: str,
    on: date,
    lookup: _PriceLookup,
    warnings: list[QueryWarning],
    warned: set[tuple[str, date]],
) -> dict[str, str] | None:
    total = Decimal(0)
    for currency, value in sorted(balances.items()):
        if value == 0:
            continue
        if currency == target:
            total += value
            continue
        rate = lookup.rate(currency, on)
        if rate is None:
            if (currency, on) not in warned:
                warned.add((currency, on))
                warnings.append(
                    QueryWarning(
                        code="missing_price",
                        message=(
                            f"No {target} price for {currency} on or before {on.isoformat()}."
                        ),
                        details={
                            "base": currency,
                            "quote": target,
                            "date": on.isoformat(),
                        },
                    )
                )
            return None
        total += value * rate
    return {"number": decimal_to_string(total), "currency": target}
