"""Shared account-name matching predicates."""

from __future__ import annotations

from typing import Any

from sqlalchemy import or_
from sqlalchemy.sql import ColumnElement


def escape_like(literal: str) -> str:
    return literal.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def account_subtree_clause(column: Any, account_name: str) -> ColumnElement:
    """Matches the account itself or any descendant (``X`` or ``X:*``)."""
    return or_(
        column == account_name,
        column.like(escape_like(account_name) + ":%", escape="\\"),
    )
