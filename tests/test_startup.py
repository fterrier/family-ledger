from __future__ import annotations

import importlib
from pathlib import Path

import pytest


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
