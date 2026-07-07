"""AST for the BQL-subset reporting query language.

See docs/specs/reporting-query.md for the grammar and semantics.

Normalization rules the parser applies when producing this AST:

- keywords are case-insensitive and do not appear in the AST
- column names, function names, and aliases are lowercased
- string literals are single-quoted in source; a doubled quote ('') inside
  a string is an escaped single quote
- date literals are unquoted YYYY-MM-DD
- number literals are parsed as Decimal
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Union


@dataclass(frozen=True)
class Column:
    name: str


@dataclass(frozen=True)
class StringLiteral:
    value: str


@dataclass(frozen=True)
class DateLiteral:
    value: date


@dataclass(frozen=True)
class NumberLiteral:
    value: Decimal


@dataclass(frozen=True)
class Star:
    """The ``*`` argument of ``count(*)``."""


@dataclass(frozen=True)
class FunctionCall:
    name: str
    args: tuple[Expr, ...]


Expr = Union[Column, FunctionCall, StringLiteral, DateLiteral, NumberLiteral, Star]


@dataclass(frozen=True)
class Target:
    expr: Expr
    alias: str | None = None


@dataclass(frozen=True)
class Condition:
    left: Expr
    op: str  # '=', '!=', '<', '<=', '>', '>=', '~'
    right: Expr


@dataclass(frozen=True)
class FromOptions:
    open_on: date | None = None
    close_on: date | None = None


@dataclass(frozen=True)
class Query:
    targets: tuple[Target, ...]
    from_options: FromOptions | None = None
    where: tuple[Condition, ...] = field(default=())
    # Each key is a lowercased alias/column name, or a 1-based ordinal.
    group_by: tuple[str | int, ...] = field(default=())
