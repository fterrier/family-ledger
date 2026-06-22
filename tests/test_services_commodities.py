from __future__ import annotations

from collections.abc import Generator

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from family_ledger.api.schemas import CommodityCreate
from family_ledger.models import Base, Commodity
from family_ledger.services import commodities as commodities_service
from family_ledger.services.errors import NotFoundError


@pytest.fixture
def session() -> Generator[Session, None, None]:
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)

    with Session(engine) as session:
        yield session


def test_update_commodity_modifies_symbol_and_returns_updated(session: Session) -> None:
    session.add(Commodity(name="commodities/cmd_old", symbol="OLDCHF"))
    session.commit()

    updated = commodities_service.update_commodity(
        session,
        "cmd_old",
        CommodityCreate(symbol="CHF"),
    )

    assert updated.symbol == "CHF"
    assert updated.name == "commodities/cmd_old"


def test_update_commodity_raises_for_missing_commodity(session: Session) -> None:
    with pytest.raises(NotFoundError) as exc_info:
        commodities_service.update_commodity(
            session,
            "cmd_missing",
            CommodityCreate(symbol="CHF"),
        )

    assert exc_info.value.code == "commodity_not_found"
