from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine, text


@pytest.fixture(autouse=True)
def configure_test_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    config_path = tmp_path / "ledger.yaml"
    config_path.write_text(
        "default_currency: CHF\n"
        "tolerance:\n"
        "  CHF: '0.01'\n"
        "uncategorized_accounts:\n"
        "  - Expenses:Uncategorized\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("FAMILY_LEDGER_DATABASE_URL", f"sqlite+pysqlite:///{db_path}")
    monkeypatch.setenv("FAMILY_LEDGER_LEDGER_CONFIG_PATH", str(config_path))


@pytest.fixture
def sqlite_database_url(tmp_path: Path) -> str:
    return f"sqlite+pysqlite:///{tmp_path / 'startup.db'}"


def assert_sqlite_connects(database_url: str) -> None:
    engine = create_engine(database_url)
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
