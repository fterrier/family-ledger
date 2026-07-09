from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from query_helpers import STANDARD_TRANSACTIONS, ZKBX_TRANSACTION, build_session
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session
from sqlalchemy.sql import Select

from family_ledger.models import Account
from family_ledger.services.errors import ValidationError
from family_ledger.services.query.ast import (
    Column,
    Condition,
    DateLiteral,
    FromOptions,
    FunctionCall,
    NumberLiteral,
    Query,
    Star,
    StringLiteral,
    Target,
)
from family_ledger.services.query.compiler import (
    ConversionSpec,
    OutputColumn,
    compile_query,
)

# ---------------------------------------------------------------------------
# AST-building shorthands
# ---------------------------------------------------------------------------

Y = Target(FunctionCall("year", (Column("date"),)), "y")
M = Target(FunctionCall("month", (Column("date"),)), "m")
SUM_POSITION_CALL = FunctionCall("sum", (Column("position"),))
LAST_BALANCE_CALL = FunctionCall("last", (Column("balance"),))
SUM_POSITION = Target(SUM_POSITION_CALL, "total")
LAST_BALANCE = Target(LAST_BALANCE_CALL, "bal")
COUNT_STAR = Target(FunctionCall("count", (Star(),)), "n")


def converted(
    inner: FunctionCall, currency: str, at: date | None = None, alias: str = "bal"
) -> Target:
    args: tuple = (inner, StringLiteral(currency))
    if at is not None:
        args += (DateLiteral(at),)
    return Target(FunctionCall("convert", args), alias)


def subtree(account_name: str) -> Condition:
    return Condition(Column("account"), "~", StringLiteral(f"^{account_name}(:|$)"))


def q(
    targets: tuple[Target, ...],
    where: tuple[Condition, ...] = (),
    group_by: tuple[str | int, ...] = (),
    from_options: FromOptions | None = None,
) -> Query:
    return Query(targets=targets, from_options=from_options, where=where, group_by=group_by)


# ---------------------------------------------------------------------------
# Seeded ledger fixture: the shared standard ledger (see query_helpers) plus
# the ZKBX boundary account that must never match the ZKB subtree.
# ---------------------------------------------------------------------------


@pytest.fixture
def session() -> Session:
    return build_session(STANDARD_TRANSACTIONS + [ZKBX_TRANSACTION])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _norm(value: Any) -> Any:
    if isinstance(value, float | Decimal):
        return Decimal(str(value))
    return value


def run_select(session: Session, stmt: Select) -> list[tuple[Any, ...]]:
    return [tuple(_norm(value) for value in row) for row in session.execute(stmt).all()]


def sql_text(stmt: Select, dialect: Any = None) -> str:
    compiled = stmt.compile(
        dialect=dialect or sqlite.dialect(),
        compile_kwargs={"literal_binds": True},
    )
    return " ".join(str(compiled).split())


# ---------------------------------------------------------------------------
# Aggregate queries: buckets, currency grouping, execution results
# ---------------------------------------------------------------------------


def test_monthly_sum_groups_by_bucket_and_currency(session: Session) -> None:
    compiled = compile_query(
        q((Y, M, SUM_POSITION), where=(subtree("Expenses:Groceries"),), group_by=("y", "m"))
    )
    assert run_select(session, compiled.select) == [
        (2025, 7, "CHF", Decimal("200")),
        (2025, 8, "CHF", Decimal("300")),
    ]


def test_subtree_regex_matches_account_and_children_only(session: Session) -> None:
    compiled = compile_query(
        q((Y, M, SUM_POSITION), where=(subtree("Assets:Checking:ZKB"),), group_by=("y", "m"))
    )
    rows = run_select(session, compiled.select)
    # ZKBX (999 CHF in 2025-09) must not leak into the ZKB subtree.
    assert rows == [
        (2025, 5, "CHF", Decimal("1000")),
        (2025, 7, "CHF", Decimal("4800")),
        (2025, 8, "CHF", Decimal("-1800")),
        (2025, 8, "USD", Decimal("50")),
    ]


def test_exact_account_match_excludes_children(session: Session) -> None:
    compiled = compile_query(
        q(
            (Y, M, SUM_POSITION),
            where=(Condition(Column("account"), "=", StringLiteral("Assets:Checking:ZKB")),),
            group_by=("y", "m"),
        )
    )
    # The USD posting lives on Assets:Checking:ZKB:Sub and must be excluded.
    assert run_select(session, compiled.select) == [
        (2025, 5, "CHF", Decimal("1000")),
        (2025, 7, "CHF", Decimal("4800")),
        (2025, 8, "CHF", Decimal("-1800")),
    ]


def test_date_bounds_filter_buckets(session: Session) -> None:
    compiled = compile_query(
        q(
            (Y, M, SUM_POSITION),
            where=(
                subtree("Expenses:Groceries"),
                Condition(Column("date"), ">=", DateLiteral(date(2025, 8, 1))),
                Condition(Column("date"), "<", DateLiteral(date(2025, 9, 1))),
            ),
            group_by=("y", "m"),
        )
    )
    assert run_select(session, compiled.select) == [(2025, 8, "CHF", Decimal("300"))]


def test_currency_filter(session: Session) -> None:
    compiled = compile_query(
        q(
            (Y, M, SUM_POSITION),
            where=(
                subtree("Assets:Checking:ZKB"),
                Condition(Column("currency"), "=", StringLiteral("USD")),
            ),
            group_by=("y", "m"),
        )
    )
    assert run_select(session, compiled.select) == [(2025, 8, "USD", Decimal("50"))]


def test_group_by_account(session: Session) -> None:
    compiled = compile_query(
        q(
            (Target(Column("account"), None), SUM_POSITION),
            where=(subtree("Expenses"),),
            group_by=("account",),
        )
    )
    assert run_select(session, compiled.select) == [
        ("Expenses:Groceries", "CHF", Decimal("500")),
        ("Expenses:Rent", "CHF", Decimal("1500")),
    ]


def test_group_by_order_does_not_change_column_pairing(session: Session) -> None:
    # GROUP BY m, y must still emit columns (and post.group_keys) in the
    # select-list order y, m — otherwise the executor pairs values with the
    # wrong key names.
    compiled = compile_query(
        q((Y, M, SUM_POSITION), where=(subtree("Expenses:Groceries"),), group_by=("m", "y"))
    )
    assert compiled.post.group_keys == ("y", "m")
    assert run_select(session, compiled.select) == [
        (2025, 7, "CHF", Decimal("200")),
        (2025, 8, "CHF", Decimal("300")),
    ]


def test_group_by_ordinals_equivalent_to_aliases(session: Session) -> None:
    by_alias = compile_query(
        q((Y, M, SUM_POSITION), where=(subtree("Expenses:Groceries"),), group_by=("y", "m"))
    )
    by_ordinal = compile_query(
        q((Y, M, SUM_POSITION), where=(subtree("Expenses:Groceries"),), group_by=(1, 2))
    )
    assert run_select(session, by_ordinal.select) == run_select(session, by_alias.select)


def test_count_star_has_no_currency_column(session: Session) -> None:
    compiled = compile_query(q((COUNT_STAR,), where=(subtree("Expenses"),)))
    assert run_select(session, compiled.select) == [(3,)]
    assert compiled.post.columns == (OutputColumn("n", "int"),)


# ---------------------------------------------------------------------------
# Journal (non-aggregate) queries
# ---------------------------------------------------------------------------


def test_journal_projection_ordered_by_date(session: Session) -> None:
    compiled = compile_query(
        q(
            (
                Target(Column("date"), None),
                Target(Column("account"), None),
                Target(Column("number"), None),
                Target(Column("currency"), None),
            ),
            where=(subtree("Expenses:Groceries"),),
        )
    )
    assert run_select(session, compiled.select) == [
        (date(2025, 7, 20), "Expenses:Groceries", Decimal("200"), "CHF"),
        (date(2025, 8, 3), "Expenses:Groceries", Decimal("300"), "CHF"),
    ]
    assert compiled.post.columns == (
        OutputColumn("date", "date"),
        OutputColumn("account", "str"),
        OutputColumn("number", "decimal"),
        OutputColumn("currency", "str"),
    )


# ---------------------------------------------------------------------------
# Regex compilation strategy
# ---------------------------------------------------------------------------


def test_anchored_prefix_regex_compiles_to_like_not_regexp() -> None:
    compiled = compile_query(
        q((Y, M, SUM_POSITION), where=(subtree("Assets:Checking:ZKB"),), group_by=("y", "m"))
    )
    sql = sql_text(compiled.select)
    assert "REGEXP" not in sql.upper()
    assert "Assets:Checking:ZKB:%" in sql
    assert "LIKE" in sql.upper()


def test_fully_anchored_literal_regex_compiles_to_equality() -> None:
    compiled = compile_query(
        q(
            (COUNT_STAR,),
            where=(Condition(Column("account"), "~", StringLiteral("^Expenses:Rent$")),),
        )
    )
    sql = sql_text(compiled.select)
    assert "REGEXP" not in sql.upper()
    assert "LIKE" not in sql.upper()
    assert "Expenses:Rent" in sql


def test_general_regex_uses_regexp_on_sqlite() -> None:
    compiled = compile_query(
        q(
            (COUNT_STAR,),
            where=(Condition(Column("account"), "~", StringLiteral("Groceries|Rent")),),
        )
    )
    assert "REGEXP" in sql_text(compiled.select).upper()


def test_general_regex_uses_tilde_on_postgres() -> None:
    compiled = compile_query(
        q(
            (COUNT_STAR,),
            where=(Condition(Column("account"), "~", StringLiteral("Groceries|Rent")),),
        )
    )
    assert "~" in sql_text(compiled.select, dialect=postgresql.dialect())


# ---------------------------------------------------------------------------
# FROM OPEN ON / CLOSE ON
# ---------------------------------------------------------------------------


def test_open_on_running_balance_produces_seed_select(session: Session) -> None:
    compiled = compile_query(
        q(
            (Y, M, LAST_BALANCE),
            where=(subtree("Assets:Checking:ZKB"),),
            group_by=("y", "m"),
            from_options=FromOptions(open_on=date(2025, 7, 1)),
        )
    )
    assert compiled.post.running_balance is True
    assert compiled.seed_select is not None
    # Seed: everything strictly before the open date, per currency.
    assert run_select(session, compiled.seed_select) == [("CHF", Decimal("1000"))]
    # Main select: per-bucket deltas from the open date on; the executor
    # accumulates these on top of the seed.
    assert run_select(session, compiled.select) == [
        (2025, 7, "CHF", Decimal("4800")),
        (2025, 8, "CHF", Decimal("-1800")),
        (2025, 8, "USD", Decimal("50")),
    ]


def test_open_on_plain_aggregate_is_only_a_date_bound(session: Session) -> None:
    compiled = compile_query(
        q(
            (Y, M, SUM_POSITION),
            where=(subtree("Assets:Checking:ZKB"),),
            group_by=("y", "m"),
            from_options=FromOptions(open_on=date(2025, 7, 1)),
        )
    )
    assert compiled.seed_select is None
    assert run_select(session, compiled.select) == [
        (2025, 7, "CHF", Decimal("4800")),
        (2025, 8, "CHF", Decimal("-1800")),
        (2025, 8, "USD", Decimal("50")),
    ]


def test_close_on_is_exclusive_upper_bound(session: Session) -> None:
    compiled = compile_query(
        q(
            (Y, M, LAST_BALANCE),
            where=(subtree("Assets:Checking:ZKB"),),
            group_by=("y", "m"),
            from_options=FromOptions(open_on=date(2025, 7, 1), close_on=date(2025, 8, 1)),
        )
    )
    assert run_select(session, compiled.select) == [(2025, 7, "CHF", Decimal("4800"))]


def test_no_open_on_means_no_seed(session: Session) -> None:
    compiled = compile_query(
        q((Y, M, LAST_BALANCE), where=(subtree("Assets:Checking:ZKB"),), group_by=("y", "m"))
    )
    assert compiled.seed_select is None
    assert compiled.post.running_balance is True


def test_post_plan_carries_open_on_for_running_balance_queries() -> None:
    compiled = compile_query(
        q(
            (Y, M, LAST_BALANCE),
            where=(subtree("Assets:Checking:ZKB"),),
            group_by=("y", "m"),
            from_options=FromOptions(open_on=date(2025, 7, 1)),
        )
    )
    assert compiled.post.open_on == date(2025, 7, 1)


def test_post_plan_open_on_is_none_without_running_balance() -> None:
    # A plain aggregate has no seed/synthetic-bucket use for open_on, so the
    # executor shouldn't be tempted to apply seed-bucket logic to it.
    compiled = compile_query(
        q(
            (Y, M, SUM_POSITION),
            where=(subtree("Assets:Checking:ZKB"),),
            group_by=("y", "m"),
            from_options=FromOptions(open_on=date(2025, 7, 1)),
        )
    )
    assert compiled.post.open_on is None


# ---------------------------------------------------------------------------
# Post plan: conversions, output columns, group keys
# ---------------------------------------------------------------------------


def test_convert_without_date_records_bucket_end_conversion(session: Session) -> None:
    compiled = compile_query(
        q(
            (Y, M, converted(LAST_BALANCE_CALL, "CHF")),
            where=(subtree("Assets:Checking:ZKB"),),
            group_by=("y", "m"),
        )
    )
    assert compiled.post.conversion == ConversionSpec("CHF", at=None)
    assert compiled.post.running_balance is True
    # Conversion never changes the SQL: same grouped per-currency deltas.
    unconverted = compile_query(
        q((Y, M, LAST_BALANCE), where=(subtree("Assets:Checking:ZKB"),), group_by=("y", "m"))
    )
    assert run_select(session, compiled.select) == run_select(session, unconverted.select)


def test_convert_with_explicit_date() -> None:
    compiled = compile_query(
        q(
            (Y, M, converted(SUM_POSITION_CALL, "CHF", at=date(2025, 12, 31), alias="total")),
            where=(subtree("Expenses"),),
            group_by=("y", "m"),
        )
    )
    assert compiled.post.conversion == ConversionSpec("CHF", at=date(2025, 12, 31))


def test_output_columns_and_group_keys_for_balance_query() -> None:
    compiled = compile_query(
        q(
            (Y, M, converted(LAST_BALANCE_CALL, "CHF")),
            where=(subtree("Assets:Checking:ZKB"),),
            group_by=("y", "m"),
        )
    )
    assert compiled.post.group_keys == ("y", "m")
    assert compiled.post.columns == (
        OutputColumn("y", "int"),
        OutputColumn("m", "int"),
        OutputColumn("bal", "amount"),
    )


def test_output_columns_for_inventory_results() -> None:
    compiled = compile_query(
        q((Y, M, SUM_POSITION), where=(subtree("Expenses"),), group_by=("y", "m"))
    )
    assert compiled.post.columns == (
        OutputColumn("y", "int"),
        OutputColumn("m", "int"),
        OutputColumn("total", "inventory"),
    )


def test_output_columns_for_unconverted_balance() -> None:
    compiled = compile_query(
        q((Y, M, LAST_BALANCE), where=(subtree("Assets:Checking:ZKB"),), group_by=("y", "m"))
    )
    assert compiled.post.columns == (
        OutputColumn("y", "int"),
        OutputColumn("m", "int"),
        OutputColumn("bal", "inventory"),
    )


# ---------------------------------------------------------------------------
# Literal binding safety
# ---------------------------------------------------------------------------


def test_string_literals_are_bound_not_interpolated(session: Session) -> None:
    hostile = "x'; DROP TABLE accounts; --"
    compiled = compile_query(
        q(
            (COUNT_STAR,),
            where=(Condition(Column("account"), "=", StringLiteral(hostile)),),
        )
    )
    assert run_select(session, compiled.select) == [(0,)]
    # The ledger survived.
    assert session.query(Account).count() == 7


# ---------------------------------------------------------------------------
# Validation errors
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("query", "reason"),
    [
        pytest.param(
            q((Target(Column("frobnicate"), None),)),
            "unknown column",
            id="unknown-column",
        ),
        pytest.param(
            q((Target(FunctionCall("median", (Column("number"),)), None),)),
            "unknown function",
            id="unknown-function",
        ),
        pytest.param(
            q(
                (Target(Column("account"), None), LAST_BALANCE),
                group_by=("account",),
            ),
            "last(balance) needs a date-bucket group key",
            id="running-balance-without-date-bucket",
        ),
        pytest.param(
            q((Y, M, SUM_POSITION), group_by=("nope",)),
            "group key must reference a target",
            id="group-by-unknown-name",
        ),
        pytest.param(
            q((Y, M, SUM_POSITION), group_by=(5,)),
            "group key ordinal out of range",
            id="group-by-ordinal-out-of-range",
        ),
        pytest.param(
            q((Target(Column("account"), None), SUM_POSITION)),
            "mixing aggregates and plain columns requires GROUP BY",
            id="mixed-aggregate-without-group-by",
        ),
        pytest.param(
            q(
                (
                    Target(
                        FunctionCall(
                            "convert",
                            (FunctionCall("sum", (Column("position"),)), Column("number")),
                        ),
                        None,
                    ),
                )
            ),
            "convert target currency must be a string literal",
            id="convert-currency-not-string",
        ),
        pytest.param(
            q(
                (COUNT_STAR,),
                where=(Condition(Column("account"), "~", DateLiteral(date(2025, 7, 1))),),
            ),
            "regex operand must be a string",
            id="regex-operand-not-string",
        ),
        pytest.param(
            q(
                (COUNT_STAR,),
                where=(Condition(Column("account"), "~", StringLiteral("(")),),
            ),
            "invalid regex",
            id="invalid-regex",
        ),
        pytest.param(
            q((Target(FunctionCall("sum", (Column("account"),)), None),)),
            "sum requires a numeric argument",
            id="sum-of-non-numeric",
        ),
        pytest.param(
            q(
                (Y, Target(Column("account"), None), LAST_BALANCE),
                group_by=("y", "account"),
            ),
            "last(balance) group keys must all be date buckets",
            id="running-balance-with-scalar-group-key",
        ),
        pytest.param(
            q((SUM_POSITION, COUNT_STAR)),
            "only one aggregate target per query",
            id="multiple-aggregate-targets",
        ),
        pytest.param(
            q(
                (Y, Target(FunctionCall("month", (Column("date"),)), "y"), COUNT_STAR),
                group_by=(1, 2),
            ),
            "duplicate output column names would silently mispair values",
            id="duplicate-output-names",
        ),
        pytest.param(
            q(
                (
                    Target(
                        FunctionCall(
                            "convert",
                            (FunctionCall("count", (Star(),)), StringLiteral("CHF")),
                        ),
                        None,
                    ),
                )
            ),
            "convert() only wraps sum() or last()",
            id="convert-of-count",
        ),
        pytest.param(
            q(
                (COUNT_STAR,),
                where=(Condition(Column("number"), ">", StringLiteral("abc")),),
            ),
            "number column compared to a string literal",
            id="where-number-vs-string",
        ),
        pytest.param(
            q(
                (COUNT_STAR,),
                where=(Condition(Column("date"), ">=", StringLiteral("zzz")),),
            ),
            "date column compared to a string literal",
            id="where-date-vs-string",
        ),
        pytest.param(
            q(
                (COUNT_STAR,),
                where=(Condition(Column("account"), "=", NumberLiteral(Decimal("5"))),),
            ),
            "string column compared to a number literal",
            id="where-string-vs-number",
        ),
    ],
)
def test_validation_errors(query: Query, reason: str) -> None:
    with pytest.raises(ValidationError) as exc_info:
        compile_query(query)
    assert exc_info.value.code == "query_validation_error", reason
