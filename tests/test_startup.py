from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from pydantic import ValidationError


def test_create_app_fails_without_ledger_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from family_ledger import config as config_module

    missing_path = tmp_path / "missing.yaml"
    monkeypatch.setenv("FAMILY_LEDGER_LEDGER_CONFIG_PATH", str(missing_path))
    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()

    with pytest.raises(FileNotFoundError):
        config_module.get_ledger_config()

    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()


def test_create_app_succeeds_with_valid_test_configuration() -> None:
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    app = main_module.create_app()

    assert app.title == "family-ledger"


def test_create_app_fails_without_api_token(monkeypatch: pytest.MonkeyPatch) -> None:
    from family_ledger import config as config_module

    monkeypatch.delenv("FAMILY_LEDGER_API_TOKEN", raising=False)
    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()

    with pytest.raises(ValidationError):
        main_module = importlib.import_module("family_ledger.main")
        main_module = importlib.reload(main_module)
        main_module.create_app()

    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()


def test_create_app_fails_without_default_tolerance(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from family_ledger import config as config_module

    config_path = tmp_path / "ledger.yaml"
    config_path.write_text(
        "default_currency: CHF\nuncategorized_accounts:\n  - Expenses:Uncategorized\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("FAMILY_LEDGER_LEDGER_CONFIG_PATH", str(config_path))
    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()

    with pytest.raises(ValidationError):
        config_module.get_ledger_config()

    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()
