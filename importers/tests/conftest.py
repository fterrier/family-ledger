from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("FAMILY_LEDGER_API_TOKEN", "test-token")


@pytest.fixture(autouse=True)
def configure_ledger_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    config_path = tmp_path / "ledger.yaml"
    config_path.write_text(
        "default_currency: CHF\n"
        "default_tolerance: '0.000001'\n"
        "tolerance:\n"
        "  CHF: '0.01'\n"
        "uncategorized_accounts:\n"
        "  - Expenses:Uncategorized\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("FAMILY_LEDGER_API_TOKEN", "test-token")
    monkeypatch.setenv("FAMILY_LEDGER_LEDGER_CONFIG_PATH", str(config_path))

    from family_ledger import config as config_module

    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()
