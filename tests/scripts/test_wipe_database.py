from __future__ import annotations

from collections.abc import Generator
from datetime import date

import pytest
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.orm import Session

from family_ledger.importers.base import BaseImporter, ImportResult
from family_ledger.models import Account, Base
from family_ledger.scripts.wipe_database import recreate_all_tables, wipe_database
from family_ledger.services.importer import list_importers


class _FakeImporter(BaseImporter):
    name = "fake"
    display_name = "Fake Importer"

    def execute(self, session: Session, file_data: bytes, config: dict) -> ImportResult:  # type: ignore[override]
        return ImportResult()


@pytest.fixture
def engine():
    _engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(_engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(_engine)
    return _engine


@pytest.fixture
def session(engine) -> Generator[Session, None, None]:
    with Session(engine) as s:
        yield s


def test_wipe_database_drops_all_tables(engine, session: Session) -> None:
    session.add(
        Account(
            name="accounts/acc_test",
            account_name="Assets:Test",
            effective_start_date=date(2020, 1, 1),
        )
    )
    session.commit()

    wipe_database(engine)

    assert inspect(engine).get_table_names() == []


def test_recreate_all_tables_restores_full_schema(engine) -> None:
    wipe_database(engine)
    recreate_all_tables(engine)

    assert set(inspect(engine).get_table_names()) == set(Base.metadata.tables.keys())


def test_list_importers_works_after_wipe(engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """After a wipe, list_importers returns registry importers with empty configs."""
    monkeypatch.setattr("family_ledger.importers.registry._importers", {"fake": _FakeImporter})

    wipe_database(engine)
    recreate_all_tables(engine)

    with Session(engine) as session:
        result = list_importers(session)

    assert len(result.importers) == 1
    assert result.importers[0].plugin_name == "fake"
    assert result.importers[0].config == {}
