from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

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
from family_ledger.services.query.parser import parse

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------


def test_select_single_column() -> None:
    assert parse("SELECT account") == Query(targets=(Target(Column("account")),))


def test_select_multiple_columns() -> None:
    assert parse("SELECT date, account, number, currency") == Query(
        targets=(
            Target(Column("date")),
            Target(Column("account")),
            Target(Column("number")),
            Target(Column("currency")),
        )
    )


def test_select_with_aliases() -> None:
    assert parse("SELECT account AS a, currency AS c") == Query(
        targets=(
            Target(Column("account"), "a"),
            Target(Column("currency"), "c"),
        )
    )


def test_keywords_and_identifiers_are_case_insensitive() -> None:
    assert parse("select Account as A") == Query(targets=(Target(Column("account"), "a"),))


def test_function_call_target() -> None:
    assert parse("SELECT year(date) AS y, month(date) AS m") == Query(
        targets=(
            Target(FunctionCall("year", (Column("date"),)), "y"),
            Target(FunctionCall("month", (Column("date"),)), "m"),
        )
    )


def test_day_function() -> None:
    assert parse("SELECT day(date) AS d") == Query(
        targets=(Target(FunctionCall("day", (Column("date"),)), "d"),)
    )


def test_nested_function_calls() -> None:
    assert parse("SELECT convert(last(balance), 'CHF') AS bal") == Query(
        targets=(
            Target(
                FunctionCall(
                    "convert",
                    (
                        FunctionCall("last", (Column("balance"),)),
                        StringLiteral("CHF"),
                    ),
                ),
                "bal",
            ),
        )
    )


def test_convert_with_explicit_date_argument() -> None:
    assert parse("SELECT convert(sum(position), 'CHF', 2025-12-31)") == Query(
        targets=(
            Target(
                FunctionCall(
                    "convert",
                    (
                        FunctionCall("sum", (Column("position"),)),
                        StringLiteral("CHF"),
                        DateLiteral(date(2025, 12, 31)),
                    ),
                )
            ),
        )
    )


def test_count_star() -> None:
    assert parse("SELECT count(*)") == Query(targets=(Target(FunctionCall("count", (Star(),))),))


# ---------------------------------------------------------------------------
# Literals
# ---------------------------------------------------------------------------


def test_string_literal_with_escaped_quote() -> None:
    assert parse("SELECT payee WHERE payee = 'It''s'") == Query(
        targets=(Target(Column("payee")),),
        where=(Condition(Column("payee"), "=", StringLiteral("It's")),),
    )


def test_date_literal() -> None:
    assert parse("SELECT account WHERE date >= 2025-07-01") == Query(
        targets=(Target(Column("account")),),
        where=(Condition(Column("date"), ">=", DateLiteral(date(2025, 7, 1))),),
    )


def test_number_literal() -> None:
    assert parse("SELECT account WHERE number > 100.50") == Query(
        targets=(Target(Column("account")),),
        where=(Condition(Column("number"), ">", NumberLiteral(Decimal("100.50"))),),
    )


def test_negative_number_literal() -> None:
    assert parse("SELECT account WHERE number < -100.50") == Query(
        targets=(Target(Column("account")),),
        where=(Condition(Column("number"), "<", NumberLiteral(Decimal("-100.50"))),),
    )


# ---------------------------------------------------------------------------
# WHERE
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("op", ["=", "!=", "<", "<=", ">", ">=", "~"])
def test_where_operators(op: str) -> None:
    parsed = parse(f"SELECT account WHERE account {op} 'Assets'")
    assert parsed.where == (Condition(Column("account"), op, StringLiteral("Assets")),)


def test_where_regex_condition() -> None:
    parsed = parse("SELECT account WHERE account ~ '^Assets:Checking(:|$)'")
    assert parsed.where == (
        Condition(Column("account"), "~", StringLiteral("^Assets:Checking(:|$)")),
    )


def test_where_multiple_and_conditions_preserve_order() -> None:
    parsed = parse(
        "SELECT account WHERE account ~ '^Expenses(:|$)'"
        " AND date >= 2025-07-01 AND currency = 'CHF'"
    )
    assert parsed.where == (
        Condition(Column("account"), "~", StringLiteral("^Expenses(:|$)")),
        Condition(Column("date"), ">=", DateLiteral(date(2025, 7, 1))),
        Condition(Column("currency"), "=", StringLiteral("CHF")),
    )


# ---------------------------------------------------------------------------
# FROM
# ---------------------------------------------------------------------------


def test_from_open_on() -> None:
    parsed = parse("SELECT account FROM OPEN ON 2025-07-01")
    assert parsed.from_options == FromOptions(open_on=date(2025, 7, 1))


def test_from_open_on_and_close_on() -> None:
    parsed = parse("SELECT account FROM OPEN ON 2025-01-01 CLOSE ON 2026-01-01")
    assert parsed.from_options == FromOptions(open_on=date(2025, 1, 1), close_on=date(2026, 1, 1))


def test_from_close_on_only() -> None:
    parsed = parse("SELECT account FROM CLOSE ON 2026-01-01")
    assert parsed.from_options == FromOptions(close_on=date(2026, 1, 1))


def test_no_from_clause_yields_none() -> None:
    assert parse("SELECT account").from_options is None


# ---------------------------------------------------------------------------
# GROUP BY
# ---------------------------------------------------------------------------


def test_group_by_identifiers() -> None:
    parsed = parse("SELECT year(date) AS y, month(date) AS m, count(*) GROUP BY y, m")
    assert parsed.group_by == ("y", "m")


def test_group_by_ordinals() -> None:
    parsed = parse("SELECT year(date) AS y, month(date) AS m, count(*) GROUP BY 1, 2")
    assert parsed.group_by == (1, 2)


def test_group_by_mixed_identifier_and_ordinal() -> None:
    parsed = parse("SELECT year(date) AS y, account, count(*) GROUP BY y, 2")
    assert parsed.group_by == ("y", 2)


def test_group_by_column_name() -> None:
    parsed = parse("SELECT account, count(*) GROUP BY account")
    assert parsed.group_by == ("account",)


# ---------------------------------------------------------------------------
# Golden queries from docs/specs/reporting-query.md
# ---------------------------------------------------------------------------


def test_golden_balance_line_query() -> None:
    parsed = parse(
        "SELECT year(date) AS y, month(date) AS m,"
        " convert(last(balance), 'CHF') AS bal"
        " FROM OPEN ON 2025-07-01"
        " WHERE account ~ '^Assets:Checking:ZKB(:|$)'"
        " GROUP BY y, m"
    )
    assert parsed == Query(
        targets=(
            Target(FunctionCall("year", (Column("date"),)), "y"),
            Target(FunctionCall("month", (Column("date"),)), "m"),
            Target(
                FunctionCall(
                    "convert",
                    (
                        FunctionCall("last", (Column("balance"),)),
                        StringLiteral("CHF"),
                    ),
                ),
                "bal",
            ),
        ),
        from_options=FromOptions(open_on=date(2025, 7, 1)),
        where=(Condition(Column("account"), "~", StringLiteral("^Assets:Checking:ZKB(:|$)")),),
        group_by=("y", "m"),
    )


def test_golden_single_currency_balance_query() -> None:
    parsed = parse(
        "SELECT year(date) AS y, month(date) AS m, last(balance) AS bal"
        " FROM OPEN ON 2025-07-01"
        " WHERE account ~ '^Assets:Checking:ZKB(:|$)' AND currency = 'CHF'"
        " GROUP BY y, m"
    )
    assert parsed == Query(
        targets=(
            Target(FunctionCall("year", (Column("date"),)), "y"),
            Target(FunctionCall("month", (Column("date"),)), "m"),
            Target(FunctionCall("last", (Column("balance"),)), "bal"),
        ),
        from_options=FromOptions(open_on=date(2025, 7, 1)),
        where=(
            Condition(Column("account"), "~", StringLiteral("^Assets:Checking:ZKB(:|$)")),
            Condition(Column("currency"), "=", StringLiteral("CHF")),
        ),
        group_by=("y", "m"),
    )


def test_golden_expense_bars_query() -> None:
    parsed = parse(
        "SELECT year(date) AS y, month(date) AS m, sum(position) AS total"
        " WHERE account ~ '^Expenses:Groceries(:|$)' AND date >= 2025-07-01"
        " GROUP BY y, m"
    )
    assert parsed == Query(
        targets=(
            Target(FunctionCall("year", (Column("date"),)), "y"),
            Target(FunctionCall("month", (Column("date"),)), "m"),
            Target(FunctionCall("sum", (Column("position"),)), "total"),
        ),
        where=(
            Condition(Column("account"), "~", StringLiteral("^Expenses:Groceries(:|$)")),
            Condition(Column("date"), ">=", DateLiteral(date(2025, 7, 1))),
        ),
        group_by=("y", "m"),
    )


# ---------------------------------------------------------------------------
# Parse errors
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "account",
        "SELECT",
        "SELECT ,",
        "SELECT account,",
        "SELECT account extra",
        "SELECT sum(position",
        "SELECT sum position)",
        "SELECT 'unterminated",
        "SELECT account WHERE",
        "SELECT account WHERE account =",
        "SELECT account WHERE account ~ 'a' OR account ~ 'b'",
        "SELECT account WHERE date >= 2025-07-01 AND",
        "SELECT account GROUP BY",
        "SELECT account GROUP",
        "SELECT account FROM OPEN ON",
        "SELECT account FROM OPEN ON 'not-a-date'",
        "SELECT account WHERE date >= 2025-13-01",
        "SELECT account WHERE date ** 2025-07-01",
        "SELECT account AS 'quoted'",
        "SELECT account; DROP TABLE accounts",
    ],
)
def test_parse_errors(text: str) -> None:
    with pytest.raises(ValidationError) as exc_info:
        parse(text)
    assert exc_info.value.code == "query_parse_error"


def test_parse_error_message_mentions_unexpected_input() -> None:
    with pytest.raises(ValidationError) as exc_info:
        parse("SELECT account extra")
    assert "extra" in exc_info.value.message
