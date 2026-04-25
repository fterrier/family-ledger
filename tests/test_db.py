from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from typing import cast

import pytest
from sqlalchemy.orm import Session

from family_ledger.db import read_only_transaction


class FakeSession:
    def __init__(self, dialect_name: str, *, in_transaction: bool = False) -> None:
        self._dialect_name = dialect_name
        self._in_transaction = in_transaction
        self.executed: list[str] = []
        self.begin = nullcontext
        self.no_autoflush = nullcontext()

    def in_transaction(self) -> bool:
        return self._in_transaction

    def get_bind(self):
        return SimpleNamespace(dialect=SimpleNamespace(name=self._dialect_name))

    def execute(self, statement) -> None:
        self.executed.append(str(statement))


def test_read_only_transaction_sets_postgres_transaction_read_only() -> None:
    session = FakeSession("postgresql")

    with read_only_transaction(cast(Session, session)):
        pass

    assert session.executed == ["SET TRANSACTION READ ONLY"]


def test_read_only_transaction_skips_sqlite_specific_statement() -> None:
    session = FakeSession("sqlite")

    with read_only_transaction(cast(Session, session)):
        pass

    assert session.executed == []


def test_read_only_transaction_requires_inactive_session() -> None:
    session = FakeSession("postgresql", in_transaction=True)

    with pytest.raises(RuntimeError, match="inactive session"):
        with read_only_transaction(cast(Session, session)):
            pass
