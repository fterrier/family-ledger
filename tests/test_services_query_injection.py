"""SQL injection defenses for the reporting query language.

Three layers, each pinned here end-to-end (query text -> parse -> compile ->
execute against SQLite):

1. the grammar is closed: raw SQL syntax (comments, quoting tricks,
   statement separators) cannot survive the lexer/parser
2. identifiers are whitelist lookups: user text never becomes an SQL
   identifier
3. literals are always bound parameters, never interpolated into SQL text —
   including LIKE patterns (with wildcard escaping) and regex patterns
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from query_helpers import build_session
from sqlalchemy import func, select
from sqlalchemy.dialects import sqlite
from sqlalchemy.orm import Session

from family_ledger.models import Account
from family_ledger.services.errors import ValidationError
from family_ledger.services.query.compiler import CompiledQuery, compile_query
from family_ledger.services.query.parser import parse

# Accounts chosen to exercise hostile-name edge cases: LIKE wildcards and a
# quote. Amounts are all distinct so a wrong match is visible in sums/counts.
_ACCOUNT_AMOUNTS: list[tuple[str, str]] = [
    ("Assets:Checking:ZKB", "100"),
    ("Assets:Checking:ZKB:Sub", "50"),
    ("Assets:Checking:%", "7"),
    ("Assets:Checking:ZK_", "3"),
    ("Assets:O'Brien", "11"),
    ("Equity:Opening", "-171"),
]


@pytest.fixture
def session() -> Session:
    return build_session(
        [("2025-07-01", [(name, amount, "CHF") for name, amount in _ACCOUNT_AMOUNTS])]
    )


def _compile(text: str) -> CompiledQuery:
    return compile_query(parse(text))


def _count(session: Session, text: str) -> int:
    return session.execute(_compile(text).select).scalar_one()


# ---------------------------------------------------------------------------
# Layer 1: raw SQL syntax cannot survive the grammar
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "SELECT account; DROP TABLE accounts",
        "SELECT account -- comment",
        "SELECT account /* comment */",
        'SELECT "account"',
        "SELECT `account`",
        "SELECT account\\",
        "SELECT account WHERE account = 'x' UNION SELECT account_name",
        "SELECT account WHERE account = 'x' OR 1=1",
    ],
)
def test_sql_syntax_is_rejected_by_the_grammar(text: str) -> None:
    with pytest.raises(ValidationError) as exc_info:
        parse(text)
    assert exc_info.value.code == "query_parse_error"


# ---------------------------------------------------------------------------
# Layer 2: identifiers are whitelist lookups, never SQL text
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "SELECT accounts_audit",
        "SELECT sqlite_master",
        "SELECT load_extension(account)",
    ],
)
def test_unknown_identifiers_never_reach_sql(text: str) -> None:
    with pytest.raises(ValidationError) as exc_info:
        _compile(text)
    assert exc_info.value.code == "query_validation_error"


# ---------------------------------------------------------------------------
# Layer 3: literals compile to bound parameters, not SQL text
# ---------------------------------------------------------------------------


HOSTILE_STRINGS = [
    "x'; DROP TABLE accounts; --",
    "' OR '1'='1",
    "x' UNION SELECT account_name FROM accounts --",
]


def _quote(value: str) -> str:
    """Embed a value in query-language string syntax ('' escapes a quote)."""
    return "'" + value.replace("'", "''") + "'"


@pytest.mark.parametrize("hostile", HOSTILE_STRINGS)
def test_string_literals_render_as_placeholders(hostile: str) -> None:
    compiled_query = _compile(f"SELECT count(*) WHERE account = {_quote(hostile)}")
    compiled_sql = compiled_query.select.compile(dialect=sqlite.dialect())
    assert hostile not in str(compiled_sql)
    assert hostile in compiled_sql.params.values()


def test_regex_patterns_render_as_placeholders() -> None:
    pattern = "Chec' OR 1=1|x"
    compiled_query = _compile(f"SELECT count(*) WHERE account ~ {_quote(pattern)}")
    compiled_sql = compiled_query.select.compile(dialect=sqlite.dialect())
    assert pattern not in str(compiled_sql)
    assert pattern in compiled_sql.params.values()


def test_date_and_number_literals_are_bound_as_typed_values() -> None:
    compiled_query = _compile("SELECT count(*) WHERE date >= 2025-07-01 AND number > 100.50")
    params = compiled_query.select.compile(dialect=sqlite.dialect()).params
    assert date(2025, 7, 1) in params.values()
    assert Decimal("100.50") in params.values()


# ---------------------------------------------------------------------------
# Layer 3, end-to-end: hostile values execute harmlessly
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("hostile", HOSTILE_STRINGS)
def test_hostile_values_match_nothing_and_destroy_nothing(session: Session, hostile: str) -> None:
    assert _count(session, f"SELECT count(*) WHERE account = {_quote(hostile)}") == 0
    assert session.execute(select(func.count()).select_from(Account)).scalar_one() == 6


def test_escaped_quote_matches_the_literal_account(session: Session) -> None:
    assert _count(session, "SELECT count(*) WHERE account = 'Assets:O''Brien'") == 1


# ---------------------------------------------------------------------------
# LIKE wildcard escaping in the subtree-regex optimization
# ---------------------------------------------------------------------------


def test_percent_in_account_name_is_not_a_like_wildcard(session: Session) -> None:
    # Unescaped, LIKE 'Assets:Checking:%:%' would also match ZKB:Sub.
    assert _count(session, "SELECT count(*) WHERE account ~ '^Assets:Checking:%(:|$)'") == 1


def test_underscore_in_account_name_is_not_a_like_wildcard(session: Session) -> None:
    # Unescaped, LIKE 'Assets:Checking:ZK_:%' would also match ZKB:Sub.
    assert _count(session, "SELECT count(*) WHERE account ~ '^Assets:Checking:ZK_(:|$)'") == 1
