from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from family_ledger.config import get_settings


def build_engine() -> Engine:
    settings = get_settings()
    return create_engine(settings.database_url, pool_pre_ping=True)


engine = build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def ping_database() -> None:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))


def get_db_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@contextmanager
def read_only_transaction(session: Session) -> Generator[Session, None, None]:
    if session.in_transaction():
        raise RuntimeError("read_only_transaction requires an inactive session")

    with session.begin():
        bind = session.get_bind()
        if bind is not None and bind.dialect.name == "postgresql":
            session.execute(text("SET TRANSACTION READ ONLY"))
        with session.no_autoflush:
            yield session
