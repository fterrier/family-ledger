from __future__ import annotations

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from family_ledger.config import get_settings


def build_engine() -> Engine:
    settings = get_settings()
    return create_engine(settings.database_url, pool_pre_ping=True)


engine = build_engine()


def ping_database() -> None:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
