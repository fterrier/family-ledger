from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from typing import cast
from unittest.mock import call, patch

import pytest
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from family_ledger.db import read_only_transaction, wait_for_database


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


def _op_error() -> OperationalError:
    return OperationalError("SELECT 1", {}, Exception("connection refused"))


def test_wait_for_database_succeeds_immediately() -> None:
    with (
        patch("family_ledger.db.ping_database") as mock_ping,
        patch("family_ledger.db.time.sleep") as mock_sleep,
    ):
        wait_for_database()

    mock_ping.assert_called_once()
    mock_sleep.assert_not_called()


def test_wait_for_database_retries_on_failure() -> None:
    with (
        patch(
            "family_ledger.db.ping_database", side_effect=[_op_error(), _op_error(), None]
        ) as mock_ping,
        patch("family_ledger.db.time.sleep") as mock_sleep,
    ):
        wait_for_database(max_attempts=5, delay=1.0)

    assert mock_ping.call_count == 3
    assert mock_sleep.call_args_list == [call(1.0), call(1.0)]


def test_wait_for_database_raises_after_max_attempts() -> None:
    with (
        patch("family_ledger.db.ping_database", side_effect=_op_error()) as mock_ping,
        patch("family_ledger.db.time.sleep"),
    ):
        with pytest.raises(OperationalError):
            wait_for_database(max_attempts=3, delay=0.0)

    assert mock_ping.call_count == 3
