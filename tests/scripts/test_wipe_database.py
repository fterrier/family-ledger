from __future__ import annotations

from collections.abc import Generator
from datetime import date

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session

from family_ledger.importers.base import BaseImporter, ImportResult
from family_ledger.models import Account, Base, Commodity, Transaction
from family_ledger.scripts.wipe_database import wipe_database, wipe_entities
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


def test_wipe_database_clears_all_rows(engine, session: Session) -> None:
    session.add(
        Account(
            name="accounts/acc_test",
            account_name="Assets:Test",
            effective_start_date=date(2020, 1, 1),
        )
    )
    session.commit()

    wipe_database(engine)

    with Session(engine) as s:
        assert s.scalar(select(Account)) is None


def test_list_importers_works_after_wipe(engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """After a wipe, list_importers returns registry importers with empty configs."""
    monkeypatch.setattr("family_ledger.importers.registry._importers", {"fake": _FakeImporter})

    wipe_database(engine)

    with Session(engine) as session:
        result = list_importers(session)

    assert len(result.importers) == 1
    assert result.importers[0].plugin_name == "fake"
    assert result.importers[0].config == {}


def test_wipe_entities_single(engine, session: Session) -> None:
    commodities = Base.metadata.tables["commodities"]
    with engine.begin() as conn:
        conn.execute(commodities.insert().values(name="commodities/CHF", symbol="CHF"))
    session.add(
        Account(
            name="accounts/test",
            account_name="Assets:Test",
            effective_start_date=date(2020, 1, 1),
        )
    )
    session.commit()

    wipe_entities(["commodity"], engine)

    with Session(engine) as s:
        assert s.scalar(select(Commodity)) is None
        assert s.scalar(select(Account)) is not None


def test_wipe_entities_multiple_in_order(engine, session: Session) -> None:
    commodities = Base.metadata.tables["commodities"]
    transactions = Base.metadata.tables["transactions"]
    with engine.begin() as conn:
        conn.execute(commodities.insert().values(name="commodities/CHF", symbol="CHF"))
        conn.execute(
            transactions.insert().values(
                name="transactions/1",
                transaction_date=date(2024, 1, 1),
                source_native_ids='["zkb_pdf:X1"]',
                entity_metadata="{}",
            )
        )

    wipe_entities(["transaction", "commodity"], engine)

    with Session(engine) as s:
        assert s.scalar(select(Transaction)) is None
        assert s.scalar(select(Commodity)) is None
