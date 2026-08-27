"""Compiler from query AST to SQLAlchemy Core selects plus a post plan.

Semantic validation happens here; invalid queries raise
``ValidationError(code="query_validation_error")``.

Contract for :class:`CompiledQuery`:

- ``select`` is the main statement over postings joined to transactions and
  accounts. Following the doctor pattern, it selects plain column tuples with
  explicit join conditions — no ORM entity hydration. Column order:

  - aggregate queries: group-key expressions in declared order, then either
    one currency column or two (``currency``, and ``value_currency`` for
    ``value()`` — see below), then one column per aggregate target:

    - no ``convert()``/``value()``: raw ``postings.units_symbol`` /
      ``units_amount`` — one currency column, unconverted.
    - ``convert(x, ...)`` wrapping a bare aggregate: the posting's *weight*
      currency/amount instead (``COALESCE(cost_symbol, price_symbol,
      units_symbol)``, summing ``COALESCE(cost_per_unit, price_per_unit, 1)
      * units_amount`` — see ``services.transaction_balancing.
      weight_symbol_column`` / ``weight_amount_column``, kept in sync with
      ``_compute_weight`` there). The weight is *always* the conversion
      basis, never a shortcut through the posting's raw units — e.g. 100
      CHF bought at cost {1.2 USD} was really 120 USD spent, and converts
      as that 120 USD re-priced at the query date's rate, not as a trivial
      100 CHF. This is a deliberate, local *historical-cost* convention —
      real bean-query's own ``convert()`` does not do this; applied
      directly to a held-at-cost position it defaults to market value
      instead (direct price, else a hop through the position's own cost/
      price currency), never the recorded cost amount. Plain currency
      postings are unaffected either way (weight == units for those, so
      this degenerates to the identity conversion).
    - ``value(x)`` (standalone, or wrapped by an outer ``convert()``): raw
      units plus a second, nullable ``value_currency`` column
      (``COALESCE(cost_symbol, price_symbol)``, no ``units_symbol``
      fallback — null means no cost/price annotation at all, i.e. nothing
      to revalue against). The executor uses the pair to look up each
      group's own market price and reduce back to a single currency — see
      ``_value_currency_column``, ``services.prices.ValuePriceLookup``, and
      the executor's ``_apply_value``. This *does* match real bean-query's
      ``value()``.

    Rows are ordered by group keys ascending, then currency (and
    value_currency, when present) ascending.
  - journal (non-aggregate) queries: the targets in declared order, rows
    ordered by transaction date ascending.

- ``seed_select`` is only present for running-balance queries
  (``last(balance)``) with ``FROM OPEN ON``: it returns ``(currency, total)``
  rows (or ``(currency, value_currency, total)`` for ``value()``) summing
  all matched postings strictly before the open date, using the same
  currency-column choice as the main select. For plain aggregate queries
  ``OPEN ON`` acts as a lower date bound only.

- ``account ~ '<regex>'`` uses regex semantics. Anchored-prefix patterns of
  the exact shape ``^<literal>(:|$)`` compile to
  ``account = <literal> OR account LIKE <literal> || ':%'``,
  multi-root alternations ``^(<lit>|<lit>|...)(:|$)`` compile to an OR of
  those per-root clauses, and ``^<literal>$`` compiles to equality; any
  other pattern compiles to the dialect regex operator (``REGEXP`` on
  SQLite, ``~`` on Postgres).

- ``convert(x, 'SYM' [, date])`` doesn't change the aggregated SQL shape,
  but does select weight over raw units as described above; the conversion
  itself is recorded in ``post.conversion`` (``at=None`` means bucket-end /
  today semantics) and applied by the executor. ``value(x)`` is recorded in
  ``post.valuation`` instead, applied by the executor's ``_apply_value``
  before ``post.conversion`` (if any) runs — see ``_basis_columns``.
  ``convert(value(x), 'SYM')`` composes both: ``value()`` revalues first,
  then ``convert()`` FX-converts the result.

All literals are bound as parameters, never interpolated.
"""

from __future__ import annotations

import operator
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import Integer, extract, func, or_, select
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
from family_ledger.services.transaction_balancing import (
    weight_amount_column,
    weight_symbol_column,
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
    # value() wraps the aggregate — market value in each group's own
    # value_currency (cost, else price), per beancount's get_value. Can
    # combine with conversion (convert(value(x), 'CUR')): value() revalues
    # first, then conversion FX-converts the result; see _basis_columns.
    valuation: bool = False
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

_KNOWN_FUNCTIONS = _BUCKET_FUNCTIONS | {"sum", "count", "last", "convert", "value"}

# A literal with no regex metacharacters — the only content the optimized
# pattern shapes accept.
_LITERAL = r"[^\\^$.|?*+()\[\]{}]+"

# Subtree match over one or more roots: ^<literal>(:|$), or the multi-root
# form ^(<literal>|<literal>|...)(:|$). Exact match: ^<literal>$.
# Anchored with \Z, not $: Python's $ also matches before a trailing newline,
# which would silently give a pattern like '^A(:|$)\n' the optimized LIKE
# semantics while the regex fallback (and beanquery) would require a literal
# newline in the account name.
_SUBTREE_PATTERN_RE = re.compile(
    rf"^\^(?:({_LITERAL})|\(({_LITERAL}(?:\|{_LITERAL})*)\))\(:\|\$\)\Z"
)
_EXACT_PATTERN_RE = re.compile(rf"^\^({_LITERAL})\$\Z")


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
    valuation: bool
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


def _analyze_target(
    target: Target,
) -> tuple[_AnalyzedTarget, ConversionSpec | None, bool]:
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
            False,
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
                False,
            )
        if expr.name == "convert":
            analyzed, spec, wraps_value = _analyze_convert(target, expr)
            return analyzed, spec, wraps_value
        if expr.name == "value":
            return _analyze_value(target, expr), None, True
        aggregate, out_type = _analyze_aggregate_call(expr)
        return (
            _AnalyzedTarget(target.alias or expr.name, out_type, "aggregate", agg=aggregate),
            None,
            False,
        )

    raise _validation_error("literal select targets are not supported")


def _unwrap_aggregate(expr: Expr, *, context: str) -> tuple[str, bool]:
    """(aggregate_kind, wraps_value) for a bare aggregate or one wrapped in
    value() — shared by _analyze_value (which rejects wraps_value, no
    double-wrapping) and _analyze_convert (which allows it, recording the
    composition on the target's ValuationSpec)."""
    if isinstance(expr, FunctionCall) and expr.name == "value":
        if len(expr.args) != 1:
            raise _validation_error("value() takes exactly one aggregate argument")
        inner = expr.args[0]
        if not isinstance(inner, FunctionCall):
            raise _validation_error("value() requires an aggregate as its argument")
        aggregate, _ = _analyze_aggregate_call(inner)
        return aggregate, True
    if isinstance(expr, FunctionCall):
        aggregate, _ = _analyze_aggregate_call(expr)
        return aggregate, False
    raise _validation_error(f"{context} requires an aggregate or value(...) argument")


def _analyze_value(target: Target, call: FunctionCall) -> _AnalyzedTarget:
    if len(call.args) != 1:
        raise _validation_error("value() takes exactly one aggregate argument")
    aggregate, wraps_value = _unwrap_aggregate(call.args[0], context="value()")
    if wraps_value:
        raise _validation_error("value() cannot wrap value()")
    if aggregate == "count":
        raise _validation_error("value() requires sum() or last() as its argument")
    return _AnalyzedTarget(target.alias or "value", "inventory", "aggregate", agg=aggregate)


def _analyze_convert(
    target: Target, call: FunctionCall
) -> tuple[_AnalyzedTarget, ConversionSpec, bool]:
    if len(call.args) not in (2, 3):
        raise _validation_error("convert() takes an aggregate, a currency, and an optional date")
    inner, currency_arg = call.args[0], call.args[1]
    if not isinstance(currency_arg, StringLiteral):
        raise _validation_error("convert() target currency must be a string literal")
    at: date | None = None
    if len(call.args) == 3:
        date_arg = call.args[2]
        if not isinstance(date_arg, DateLiteral):
            raise _validation_error("convert() date must be a date literal")
        at = date_arg.value

    aggregate, wraps_value = _unwrap_aggregate(inner, context="convert()")
    if aggregate == "count":
        raise _validation_error("convert() requires sum() or last() as its first argument")
    analyzed = _AnalyzedTarget(target.alias or "convert", "amount", "aggregate", agg=aggregate)
    return analyzed, ConversionSpec(currency_arg.value, at=at), wraps_value


def _analyze(query: Query) -> _Analysis:
    targets: list[_AnalyzedTarget] = []
    conversion: ConversionSpec | None = None
    valuation = False

    for target in query.targets:
        analyzed, spec, wraps_value = _analyze_target(target)
        if spec is not None:
            if conversion is not None:
                raise _validation_error("only one convert() per query is supported")
            conversion = spec
        if wraps_value:
            if valuation:
                raise _validation_error("only one value() per query is supported")
            valuation = True
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
        valuation=valuation,
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
    subtree_match = _SUBTREE_PATTERN_RE.match(pattern)
    if subtree_match:
        # Group 1 is the bare single-root form (which can't contain '|'),
        # group 2 the parenthesized alternation — either way, one clause per
        # root, OR-ed together.
        roots = (subtree_match.group(1) or subtree_match.group(2)).split("|")
        return or_(*(account_subtree_clause(column, root) for root in roots))
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
    # Inner join to Account: an accountless posting (a split's not-yet-
    # categorized remainder, Posting.account_id IS NULL) has no row to join
    # and is therefore intentionally invisible to every /query result —
    # same "ignore entirely until categorized" semantics as Doctor.
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


def _aggregate_sql(target: _AnalyzedTarget, amount_column: ColumnElement) -> ColumnElement:
    if target.agg == "count":
        return func.count().label(target.name)
    # sum(position) and last(balance) both emit per-group sums; the executor
    # accumulates last(balance) deltas into a running balance.
    return func.sum(amount_column).label(target.name)


def _value_currency_column() -> ColumnElement:
    """A held position's value currency (cost, else price — never falling
    back to units_symbol, unlike weight_symbol_column): null means no
    cost/price annotation at all, which value() must treat as nothing to
    price against — the position passes through as raw units instead.
    See services/prices.py's ValuePriceLookup and executor._apply_value."""
    return func.coalesce(Posting.cost_symbol, Posting.price_symbol)


def _basis_columns(
    conversion: ConversionSpec | None, valuation: bool
) -> tuple[Any, Any, Any | None]:
    # convert() means the query cares about *value*, not share/unit count: a
    # security posting (e.g. 100 VSS at cost) converts via its cost currency
    # (the weight) — always, never a shortcut through raw units just
    # because they happen to already be the target currency (100 CHF
    # bought at cost {1.2 USD} was really 120 USD spent) — same rule as
    # GET /transactions?convert=. Without convert(), position/balance stay
    # raw-units inventories, unchanged.
    #
    # value() is different again: it needs the *raw* units (to multiply by
    # a market price), plus a second column — value_currency — so the
    # executor knows which currency each group's price should be quoted in
    # (see _value_currency_column). Returns (currency, amount,
    # value_currency); value_currency is only non-None for valuation.
    if not valuation and conversion is not None:
        return weight_symbol_column(), weight_amount_column(), None
    value_currency = _value_currency_column() if valuation else None
    return Posting.units_symbol, Posting.units_amount, value_currency


def _build_aggregate_select(
    analysis: _Analysis,
    grouped: list[_AnalyzedTarget],
    where: list[ColumnElement],
    needs_currency: bool,
) -> Select:
    currency_column, amount_column, value_currency_column = _basis_columns(
        analysis.conversion, analysis.valuation
    )

    columns: list[Any] = [_sql(t).label(t.name) for t in grouped]
    if needs_currency:
        columns.append(currency_column.label("currency"))
        if value_currency_column is not None:
            columns.append(value_currency_column.label("value_currency"))
    columns.extend(
        _aggregate_sql(t, amount_column) for t in analysis.targets if t.kind == "aggregate"
    )

    stmt = _base_select(columns).where(*where)

    group_by: list[Any] = [_sql(t) for t in grouped]
    if needs_currency:
        group_by.append(currency_column)
        if value_currency_column is not None:
            group_by.append(value_currency_column)
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


def _build_seed_select(
    non_date_where: list[ColumnElement],
    open_on: date,
    conversion: ConversionSpec | None,
    valuation: bool,
) -> Select:
    currency_column, amount_column, value_currency_column = _basis_columns(conversion, valuation)
    columns: list[Any] = [currency_column.label("currency")]
    group_by: list[Any] = [currency_column]
    if value_currency_column is not None:
        columns.append(value_currency_column.label("value_currency"))
        group_by.append(value_currency_column)
    columns.append(func.sum(amount_column).label("total"))
    return (
        _base_select(columns)
        .where(*non_date_where)
        .where(Transaction.transaction_date < open_on)
        .group_by(*group_by)
        .order_by(*group_by)
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
        seed_select = _build_seed_select(
            non_date_where, open_on, analysis.conversion, analysis.valuation
        )

    return CompiledQuery(
        select=stmt,
        seed_select=seed_select,
        post=PostPlan(
            columns=tuple(OutputColumn(t.name, t.out_type) for t in analysis.targets),
            group_keys=tuple(t.name for t in grouped),
            running_balance=analysis.running_balance,
            conversion=analysis.conversion,
            valuation=analysis.valuation,
            is_aggregate=analysis.has_aggregates,
            group_key_buckets=tuple(t.bucket for t in grouped),
            open_on=open_on if analysis.running_balance else None,
        ),
    )
