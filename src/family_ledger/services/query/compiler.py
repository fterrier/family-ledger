"""Compiler from query AST to SQLAlchemy Core selects plus a post plan.

Semantic validation happens here; invalid queries raise
``ValidationError(code="query_validation_error")``.

Contract for :class:`CompiledQuery`:

- ``select`` is the main statement over postings joined to transactions and
  accounts. Following the doctor pattern, it selects plain column tuples with
  explicit join conditions — no ORM entity hydration. Column order:

  - aggregate queries: group-key expressions in declared order, then
    ``postings.units_symbol`` (whenever the query aggregates ``position`` or
    ``balance``), then one column per aggregate target. Rows are ordered by
    group keys ascending, then currency ascending.
  - journal (non-aggregate) queries: the targets in declared order, rows
    ordered by transaction date ascending.

- ``seed_select`` is only present for running-balance queries
  (``last(balance)``) with ``FROM OPEN ON``: it returns ``(currency, total)``
  rows summing all matched postings strictly before the open date. For plain
  aggregate queries ``OPEN ON`` acts as a lower date bound only.

- ``account ~ '<regex>'`` uses regex semantics. Anchored-prefix patterns of
  the exact shape ``^<literal>(:|$)`` compile to
  ``account = <literal> OR account LIKE <literal> || ':%'`` and
  ``^<literal>$`` compiles to equality; any other pattern compiles to the
  dialect regex operator (``REGEXP`` on SQLite, ``~`` on Postgres).

- ``convert(x, 'SYM' [, date])`` never changes the SQL; it is recorded in
  ``post.conversion`` (``at=None`` means bucket-end / today semantics).

All literals are bound as parameters, never interpolated.
"""

from __future__ import annotations

import operator
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import Integer, extract, func, select
from sqlalchemy import cast as sa_cast
from sqlalchemy.sql import ColumnElement, Select

from family_ledger.models import Account, Posting, Transaction
from family_ledger.services.account_matching import account_subtree_clause
from family_ledger.services.errors import ValidationError
from family_ledger.services.query.ast import (
    Column,
    Condition,
    DateLiteral,
    Expr,
    FunctionCall,
    NumberLiteral,
    Query,
    Star,
    StringLiteral,
    Target,
)


@dataclass(frozen=True)
class OutputColumn:
    name: str
    # one of: 'int', 'str', 'date', 'decimal', 'amount', 'inventory'
    type: str


@dataclass(frozen=True)
class ConversionSpec:
    target_currency: str
    # explicit conversion date; None = bucket end date (grouped) / today
    at: date | None = None


@dataclass(frozen=True)
class PostPlan:
    columns: tuple[OutputColumn, ...]
    # Select-list order (same order as the SQL group-key columns), regardless
    # of the order keys were written in GROUP BY.
    group_keys: tuple[str, ...] = field(default=())
    running_balance: bool = False
    conversion: ConversionSpec | None = None
    is_aggregate: bool = False
    # aligned with group_keys: 'year' | 'month' | 'day' for bucket keys,
    # None for scalar keys
    group_key_buckets: tuple[str | None, ...] = field(default=())
    # FROM OPEN ON date, when running_balance is True and a seed exists.
    # Lets the executor synthesize a single seed-only bucket for accounts
    # with a nonzero opening balance but zero postings inside the window.
    open_on: date | None = None


@dataclass(frozen=True)
class CompiledQuery:
    select: Select
    seed_select: Select | None
    post: PostPlan


# ---------------------------------------------------------------------------
# Language surface
# ---------------------------------------------------------------------------

_SCALAR_COLUMNS: dict[str, tuple[Any, str]] = {
    "date": (Transaction.transaction_date, "date"),
    "account": (Account.account_name, "str"),
    "payee": (Transaction.payee, "str"),
    "narration": (Transaction.narration, "str"),
    "number": (Posting.units_amount, "decimal"),
    "currency": (Posting.units_symbol, "str"),
}

_AGGREGATE_ONLY_COLUMNS = {"position": "sum()", "balance": "last()"}

_BUCKET_FUNCTIONS = frozenset({"year", "month", "day"})

_KNOWN_FUNCTIONS = _BUCKET_FUNCTIONS | {"sum", "count", "last", "convert"}

# ^<literal>(:|$) and ^<literal>$ where <literal> has no regex metacharacters
_PREFIX_PATTERN_RE = re.compile(r"^\^([^\\^$.|?*+()\[\]{}]+)\(:\|\$\)$")
_EXACT_PATTERN_RE = re.compile(r"^\^([^\\^$.|?*+()\[\]{}]+)\$$")


def _validation_error(message: str) -> ValidationError:
    return ValidationError(code="query_validation_error", message=message)


# ---------------------------------------------------------------------------
# Target analysis
# ---------------------------------------------------------------------------


@dataclass
class _AnalyzedTarget:
    name: str
    out_type: str
    kind: str  # 'scalar' | 'bucket' | 'aggregate'
    sql: ColumnElement | None = None  # for scalar/bucket targets
    agg: str | None = None  # 'sum' | 'count' | 'last'
    bucket: str | None = None  # 'year' | 'month' | 'day' for bucket targets


@dataclass
class _Analysis:
    targets: list[_AnalyzedTarget]
    conversion: ConversionSpec | None
    running_balance: bool
    has_aggregates: bool


def _analyze_aggregate_call(call: FunctionCall) -> tuple[str, str]:
    if call.name == "sum":
        if len(call.args) != 1 or not isinstance(call.args[0], Column):
            raise _validation_error("sum() takes exactly one column argument")
        argument = call.args[0]
        if argument.name not in ("position", "number"):
            raise _validation_error(f"sum() requires a numeric argument, got '{argument.name}'")
        return "sum", "inventory"
    if call.name == "count":
        if call.args != (Star(),):
            raise _validation_error("count() only supports count(*)")
        return "count", "int"
    if call.name == "last":
        if call.args != (Column("balance"),):
            raise _validation_error("last() only supports last(balance)")
        return "last", "inventory"
    if call.name not in _KNOWN_FUNCTIONS:
        raise _validation_error(f"unknown function '{call.name}'")
    raise _validation_error(f"'{call.name}' cannot be used as an aggregate")


def _analyze_target(target: Target) -> tuple[_AnalyzedTarget, ConversionSpec | None]:
    expr = target.expr

    if isinstance(expr, Column):
        if expr.name in _AGGREGATE_ONLY_COLUMNS:
            raise _validation_error(
                f"column '{expr.name}' can only be used inside {_AGGREGATE_ONLY_COLUMNS[expr.name]}"
            )
        if expr.name not in _SCALAR_COLUMNS:
            raise _validation_error(f"unknown column '{expr.name}'")
        sql, out_type = _SCALAR_COLUMNS[expr.name]
        return (
            _AnalyzedTarget(target.alias or expr.name, out_type, "scalar", sql=sql),
            None,
        )

    if isinstance(expr, FunctionCall):
        if expr.name in _BUCKET_FUNCTIONS:
            if expr.args != (Column("date"),):
                raise _validation_error(f"{expr.name}() expects the date column")
            sql = sa_cast(extract(expr.name, Transaction.transaction_date), Integer)
            return (
                _AnalyzedTarget(
                    target.alias or expr.name, "int", "bucket", sql=sql, bucket=expr.name
                ),
                None,
            )
        if expr.name == "convert":
            return _analyze_convert(target, expr)
        aggregate, out_type = _analyze_aggregate_call(expr)
        return (
            _AnalyzedTarget(target.alias or expr.name, out_type, "aggregate", agg=aggregate),
            None,
        )

    raise _validation_error("literal select targets are not supported")


def _analyze_convert(target: Target, call: FunctionCall) -> tuple[_AnalyzedTarget, ConversionSpec]:
    if len(call.args) not in (2, 3):
        raise _validation_error("convert() takes an aggregate, a currency, and an optional date")
    inner, currency_arg = call.args[0], call.args[1]
    if not isinstance(inner, FunctionCall):
        raise _validation_error("convert() requires an aggregate as its first argument")
    if not isinstance(currency_arg, StringLiteral):
        raise _validation_error("convert() target currency must be a string literal")
    at: date | None = None
    if len(call.args) == 3:
        date_arg = call.args[2]
        if not isinstance(date_arg, DateLiteral):
            raise _validation_error("convert() date must be a date literal")
        at = date_arg.value

    aggregate, _ = _analyze_aggregate_call(inner)
    if aggregate == "count":
        raise _validation_error("convert() requires sum() or last() as its first argument")
    analyzed = _AnalyzedTarget(target.alias or "convert", "amount", "aggregate", agg=aggregate)
    return analyzed, ConversionSpec(currency_arg.value, at=at)


def _analyze(query: Query) -> _Analysis:
    targets: list[_AnalyzedTarget] = []
    conversion: ConversionSpec | None = None

    for target in query.targets:
        analyzed, spec = _analyze_target(target)
        if spec is not None:
            if conversion is not None:
                raise _validation_error("only one convert() per query is supported")
            conversion = spec
        targets.append(analyzed)

    # The executor pairs row values with plan columns by name; duplicates
    # would silently mispair them.
    names = [t.name for t in targets]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise _validation_error("duplicate output column name: " + ", ".join(duplicates))

    return _Analysis(
        targets=targets,
        conversion=conversion,
        running_balance=any(t.agg == "last" for t in targets),
        has_aggregates=any(t.kind == "aggregate" for t in targets),
    )


# ---------------------------------------------------------------------------
# Group key resolution
# ---------------------------------------------------------------------------


def _resolve_group_keys(query: Query, analysis: _Analysis) -> list[_AnalyzedTarget]:
    selected: set[int] = set()
    for key in query.group_by:
        if isinstance(key, int):
            if not 1 <= key <= len(analysis.targets):
                raise _validation_error(f"group key ordinal {key} is out of range")
            index = key - 1
        else:
            indices = [i for i, t in enumerate(analysis.targets) if t.name == key]
            if not indices:
                raise _validation_error(f"group key '{key}' does not match any select target")
            index = indices[0]
        target = analysis.targets[index]
        if target.kind == "aggregate":
            raise _validation_error(f"group key '{target.name}' references an aggregate")
        selected.add(index)
    # Select-list order everywhere: the SQL columns, GROUP BY, and PostPlan
    # all share it, so the executor's positional row access cannot diverge
    # from the plan when GROUP BY lists keys in a different order.
    return [t for i, t in enumerate(analysis.targets) if i in selected]


# ---------------------------------------------------------------------------
# WHERE compilation
# ---------------------------------------------------------------------------


def _compile_regex(column: Any, pattern: str) -> ColumnElement:
    prefix_match = _PREFIX_PATTERN_RE.match(pattern)
    if prefix_match:
        return account_subtree_clause(column, prefix_match.group(1))
    exact_match = _EXACT_PATTERN_RE.match(pattern)
    if exact_match:
        return column == exact_match.group(1)
    try:
        re.compile(pattern)
    except re.error as exc:
        raise _validation_error(f"invalid regex '{pattern}': {exc}") from exc
    return column.regexp_match(pattern)


# Which literal node each column type can be compared against; anything else
# would either error inside the database (400 on Postgres becomes 500) or
# silently match nothing (SQLite orders numbers before text).
_LITERAL_FOR_COLUMN_TYPE: dict[str, tuple[type, str]] = {
    "date": (DateLiteral, "a date literal (YYYY-MM-DD)"),
    "decimal": (NumberLiteral, "a number literal"),
    "str": (StringLiteral, "a string literal"),
}


def _literal_value(column_name: str, column_type: str, expr: Expr) -> Any:
    expected, description = _LITERAL_FOR_COLUMN_TYPE[column_type]
    if isinstance(expr, StringLiteral | DateLiteral | NumberLiteral) and isinstance(expr, expected):
        return expr.value
    raise _validation_error(f"'{column_name}' comparisons require {description}")


def _compile_conditions(
    query: Query,
) -> tuple[list[ColumnElement], list[ColumnElement]]:
    """Returns (non-date clauses, date clauses); the split feeds the seed select."""
    non_date_clauses: list[ColumnElement] = []
    date_clauses: list[ColumnElement] = []

    for condition in query.where:
        if not isinstance(condition.left, Column):
            raise _validation_error("condition left-hand side must be a column")
        name = condition.left.name
        if name in _AGGREGATE_ONLY_COLUMNS:
            raise _validation_error(f"column '{name}' cannot be used in WHERE")
        if name not in _SCALAR_COLUMNS:
            raise _validation_error(f"unknown column '{name}'")
        column, column_type = _SCALAR_COLUMNS[name]

        clause = _compile_condition(name, column, column_type, condition)
        if name == "date":
            date_clauses.append(clause)
        else:
            non_date_clauses.append(clause)

    return non_date_clauses, date_clauses


_COMPARISON_OPS = {
    "=": operator.eq,
    "!=": operator.ne,
    "<": operator.lt,
    "<=": operator.le,
    ">": operator.gt,
    ">=": operator.ge,
}


def _compile_condition(
    name: str, column: Any, column_type: str, condition: Condition
) -> ColumnElement:
    if condition.op == "~":
        if not isinstance(condition.right, StringLiteral):
            raise _validation_error("the ~ operator requires a string regex operand")
        return _compile_regex(column, condition.right.value)
    value = _literal_value(name, column_type, condition.right)
    return _COMPARISON_OPS[condition.op](column, value)


# ---------------------------------------------------------------------------
# Select construction
# ---------------------------------------------------------------------------


def _base_select(columns: Sequence[Any]) -> Select:
    return (
        select(*columns)
        .select_from(Posting)
        .join(Transaction, Posting.transaction_id == Transaction.id)
        .join(Account, Account.id == Posting.account_id)
    )


def _sql(target: _AnalyzedTarget) -> ColumnElement:
    # Scalar and bucket targets always carry a SQL expression.
    assert target.sql is not None
    return target.sql


def _aggregate_sql(target: _AnalyzedTarget) -> ColumnElement:
    if target.agg == "count":
        return func.count().label(target.name)
    # sum(position) and last(balance) both emit per-group sums; the executor
    # accumulates last(balance) deltas into a running balance.
    return func.sum(Posting.units_amount).label(target.name)


def _build_aggregate_select(
    analysis: _Analysis,
    grouped: list[_AnalyzedTarget],
    where: list[ColumnElement],
    needs_currency: bool,
) -> Select:
    columns: list[Any] = [_sql(t).label(t.name) for t in grouped]
    if needs_currency:
        columns.append(Posting.units_symbol.label("currency"))
    columns.extend(_aggregate_sql(t) for t in analysis.targets if t.kind == "aggregate")

    stmt = _base_select(columns).where(*where)

    group_by: list[Any] = [_sql(t) for t in grouped]
    if needs_currency:
        group_by.append(Posting.units_symbol)
    if group_by:
        stmt = stmt.group_by(*group_by).order_by(*group_by)
    return stmt


def _build_journal_select(analysis: _Analysis, where: list[ColumnElement]) -> Select:
    columns = [_sql(t).label(t.name) for t in analysis.targets]
    return (
        _base_select(columns)
        .where(*where)
        .order_by(Transaction.transaction_date, Transaction.name, Posting.posting_order)
    )


def _build_seed_select(non_date_where: list[ColumnElement], open_on: date) -> Select:
    return (
        _base_select(
            [
                Posting.units_symbol.label("currency"),
                func.sum(Posting.units_amount).label("total"),
            ]
        )
        .where(*non_date_where)
        .where(Transaction.transaction_date < open_on)
        .group_by(Posting.units_symbol)
        .order_by(Posting.units_symbol)
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def compile_query(query: Query) -> CompiledQuery:
    analysis = _analyze(query)
    grouped = _resolve_group_keys(query, analysis)

    if analysis.has_aggregates:
        aggregates = [t for t in analysis.targets if t.kind == "aggregate"]
        if len(aggregates) > 1:
            raise _validation_error("only one aggregate target per query is supported")
        ungrouped = [t.name for t in analysis.targets if t.kind != "aggregate" and t not in grouped]
        if ungrouped:
            raise _validation_error(
                "non-aggregate targets must appear in GROUP BY: " + ", ".join(ungrouped)
            )
    else:
        if query.group_by:
            raise _validation_error("GROUP BY requires at least one aggregate target")

    # Buckets-only because the executor accumulates one running balance
    # linearly across the whole result set; scalar group keys would need
    # partition-aware accumulation in executor._assemble_aggregate.
    if analysis.running_balance and (not grouped or any(t.kind != "bucket" for t in grouped)):
        raise _validation_error(
            "last(balance) requires grouping by date buckets only (year/month/day)"
        )

    non_date_where, date_where = _compile_conditions(query)

    open_on = query.from_options.open_on if query.from_options else None
    close_on = query.from_options.close_on if query.from_options else None
    bounds: list[ColumnElement] = []
    if open_on is not None:
        bounds.append(Transaction.transaction_date >= open_on)
    if close_on is not None:
        bounds.append(Transaction.transaction_date < close_on)

    needs_currency = any(t.agg in ("sum", "last") for t in analysis.targets)

    where = non_date_where + date_where + bounds
    if analysis.has_aggregates:
        stmt = _build_aggregate_select(analysis, grouped, where, needs_currency)
    else:
        stmt = _build_journal_select(analysis, where)

    seed_select = None
    if analysis.running_balance and open_on is not None:
        seed_select = _build_seed_select(non_date_where, open_on)

    return CompiledQuery(
        select=stmt,
        seed_select=seed_select,
        post=PostPlan(
            columns=tuple(OutputColumn(t.name, t.out_type) for t in analysis.targets),
            group_keys=tuple(t.name for t in grouped),
            running_balance=analysis.running_balance,
            conversion=analysis.conversion,
            is_aggregate=analysis.has_aggregates,
            group_key_buckets=tuple(t.bucket for t in grouped),
            open_on=open_on if analysis.running_balance else None,
        ),
    )
