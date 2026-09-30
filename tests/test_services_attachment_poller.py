from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import patch

from sqlalchemy.engine import Connection, Engine

from family_ledger.config import Settings
from family_ledger.services import attachment_poller


class FakeConnection:
    def __init__(self, dialect_name: str, *, advisory_lock_result: bool = True) -> None:
        self.dialect = SimpleNamespace(name=dialect_name)
        self._advisory_lock_result = advisory_lock_result
        self.executed: list[str] = []
        self.closed = False
        self.commits = 0

    def execute(self, statement: Any, params: dict[str, Any] | None = None) -> Any:
        self.executed.append(str(statement))
        if "pg_try_advisory_lock" in str(statement):
            return SimpleNamespace(scalar=lambda: self._advisory_lock_result)
        return SimpleNamespace(scalar=lambda: None)

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        self.closed = True


class FakeEngine:
    def __init__(self, connection: FakeConnection) -> None:
        self._connection = connection

    def connect(self) -> FakeConnection:
        return self._connection


def make_settings() -> Settings:
    return Settings(api_token="test-token", attachment_poller_enabled=False)


def test_try_become_leader_acquires_postgres_advisory_lock():
    conn = FakeConnection("postgresql", advisory_lock_result=True)
    engine = FakeEngine(conn)

    result = attachment_poller._try_become_leader(cast(Engine, engine))

    assert result is conn
    assert not conn.closed
    assert any("pg_try_advisory_lock" in stmt for stmt in conn.executed)
    # must not sit idle-in-transaction for as long as this worker is
    # leader - see the comment in _try_become_leader.
    assert conn.commits == 1


def test_try_become_leader_returns_none_when_lock_unavailable():
    conn = FakeConnection("postgresql", advisory_lock_result=False)
    engine = FakeEngine(conn)

    result = attachment_poller._try_become_leader(cast(Engine, engine))

    assert result is None
    assert conn.closed  # a non-leader must not hold the connection open
    assert conn.commits == 1


def test_try_become_leader_skips_lock_on_non_postgres_dialect():
    conn = FakeConnection("sqlite")
    engine = FakeEngine(conn)

    result = attachment_poller._try_become_leader(cast(Engine, engine))

    assert result is conn
    assert conn.executed == []  # never touches the DB on a non-postgres dialect


def test_poll_cycle_skips_processing_when_not_leader():
    conn = FakeConnection("postgresql", advisory_lock_result=False)
    engine = FakeEngine(conn)
    settings = make_settings()

    with patch(
        "family_ledger.services.attachment_poller.attachments.process_pending_attachments"
    ) as mock_process:
        result = attachment_poller._poll_cycle(cast(Engine, engine), None, settings)

    assert result is None
    mock_process.assert_not_called()


def test_poll_cycle_processes_once_it_is_leader():
    conn = FakeConnection("postgresql", advisory_lock_result=True)
    engine = FakeEngine(conn)
    settings = make_settings()

    with patch(
        "family_ledger.services.attachment_poller.attachments.process_pending_attachments"
    ) as mock_process:
        result = attachment_poller._poll_cycle(cast(Engine, engine), None, settings)

    assert result is conn
    mock_process.assert_called_once()


def test_poll_cycle_reuses_an_already_held_leader_lock_without_reacquiring():
    conn = FakeConnection("postgresql", advisory_lock_result=True)
    engine = FakeEngine(conn)
    settings = make_settings()

    with patch(
        "family_ledger.services.attachment_poller.attachments.process_pending_attachments"
    ) as mock_process:
        result = attachment_poller._poll_cycle(
            cast(Engine, engine), cast(Connection, conn), settings
        )

    assert result is conn
    mock_process.assert_called_once()
    # no second attempt to acquire the lock - it was already held
    assert not any("pg_try_advisory_lock" in stmt for stmt in conn.executed)


def test_poll_cycle_keeps_the_leader_lock_even_when_processing_raises_unexpectedly():
    # process_pending_attachments' own session.commit() isn't wrapped in
    # commit_or_raise, so a raw SQLAlchemy error (not a ServiceError) is a
    # real possibility - it must not escape this cycle and orphan the
    # advisory lock (_poll_forever has no try/except of its own around
    # this call).
    conn = FakeConnection("postgresql", advisory_lock_result=True)
    engine = FakeEngine(conn)
    settings = make_settings()

    with patch(
        "family_ledger.services.attachment_poller.attachments.process_pending_attachments",
        side_effect=RuntimeError("unexpected db error"),
    ):
        result = attachment_poller._poll_cycle(cast(Engine, engine), None, settings)

    assert result is conn
    assert not conn.closed


def test_release_leader_unlocks_and_closes_on_postgres():
    conn = FakeConnection("postgresql")

    attachment_poller._release_leader(cast(Connection, conn))

    assert any("pg_advisory_unlock" in stmt for stmt in conn.executed)
    assert conn.closed


def test_release_leader_just_closes_on_non_postgres():
    conn = FakeConnection("sqlite")

    attachment_poller._release_leader(cast(Connection, conn))

    assert conn.executed == []
    assert conn.closed
