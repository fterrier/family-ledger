from __future__ import annotations

import os
from collections.abc import Generator
from pathlib import Path

import pytest
from alembic.config import Config as AlembicConfig
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from testcontainers.postgres import PostgresContainer

from alembic import command as alembic_command
from family_ledger import config as config_module
from family_ledger import db as db_module

# tests/integration/ -> tests/ -> project root
_PROJECT_ROOT = Path(__file__).parents[2]
_SAVEPOINT_MODE = "create_savepoint"


@pytest.fixture(scope="session")
def postgres_container():
    with PostgresContainer("postgres:17", driver="psycopg") as container:
        yield container


@pytest.fixture(scope="session")
def integration_database_url(postgres_container) -> str:
    return postgres_container.get_connection_url()


@pytest.fixture(scope="session")
def integration_ledger_config_path(tmp_path_factory) -> Path:
    config_dir = tmp_path_factory.mktemp("ledger")
    config_path = config_dir / "ledger.yaml"
    config_path.write_text(
        "default_currency: CHF\n"
        "default_tolerance: '0.000001'\n"
        "tolerance:\n"
        "  CHF: '0.01'\n"
        "uncategorized_accounts:\n"
        "  - Expenses:Uncategorized\n",
        encoding="utf-8",
    )
    return config_path


@pytest.fixture(scope="session")
def _setup_integration_env(
    integration_database_url: str,
    integration_ledger_config_path: Path,
) -> None:
    os.environ["FAMILY_LEDGER_DATABASE_URL"] = integration_database_url
    os.environ.setdefault("FAMILY_LEDGER_API_TOKEN", "test-token")
    os.environ["FAMILY_LEDGER_LEDGER_CONFIG_PATH"] = str(integration_ledger_config_path)
    os.environ["FAMILY_LEDGER_ATTACHMENT_POLLER_ENABLED"] = "false"


@pytest.fixture(scope="session")
def run_migrations(_setup_integration_env) -> None:
    config_module.get_settings.cache_clear()
    alembic_cfg = AlembicConfig(str(_PROJECT_ROOT / "alembic.ini"))
    alembic_command.upgrade(alembic_cfg, "head")
    config_module.get_settings.cache_clear()


@pytest.fixture(scope="session")
def integration_engine(integration_database_url: str, run_migrations):
    engine = create_engine(integration_database_url, pool_pre_ping=True)
    yield engine
    engine.dispose()


@pytest.fixture(scope="session", autouse=True)
def _swap_to_postgres_engine(integration_engine) -> None:
    """One-time: replace the module-level startup engine with the test Postgres engine."""
    db_module.engine.dispose()
    db_module.engine = integration_engine


@pytest.fixture
def pg_connection(integration_engine):
    with integration_engine.connect() as conn:
        conn.begin()
        yield conn
        conn.rollback()


@pytest.fixture(autouse=True)
def configure_test_environment(pg_connection) -> Generator[None, None, None]:
    """Override the SQLite autouse fixture from tests/conftest.py."""
    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()

    db_module.SessionLocal.configure(
        bind=pg_connection,
        join_transaction_mode=_SAVEPOINT_MODE,
    )

    yield


@pytest.fixture
def integration_client() -> TestClient:
    from api_helpers import make_client

    return make_client()


@pytest.fixture
def integration_session(pg_connection) -> Generator[Session, None, None]:
    with Session(pg_connection, join_transaction_mode=_SAVEPOINT_MODE) as session:
        yield session
