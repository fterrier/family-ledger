from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
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


def test_create_app_starts_and_stops_attachment_poller_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger import config as config_module

    events: list[str] = []

    def fake_start(settings):
        events.append(f"start:{settings.paperless_base_url}")
        return ("stop-event", "thread")

    def fake_stop(stop_event, thread) -> None:
        events.append(f"stop:{stop_event}:{thread}")

    monkeypatch.setenv("FAMILY_LEDGER_PAPERLESS_BASE_URL", "https://paperless.example.com")
    monkeypatch.setenv("FAMILY_LEDGER_PAPERLESS_TOKEN", "paperless-token")
    monkeypatch.setenv("FAMILY_LEDGER_ATTACHMENT_POLLER_ENABLED", "true")
    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()
    monkeypatch.setattr(
        "family_ledger.services.attachment_poller.start_attachment_poller",
        fake_start,
    )
    monkeypatch.setattr(
        "family_ledger.services.attachment_poller.stop_attachment_poller",
        fake_stop,
    )

    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)

    with TestClient(main_module.create_app()):
        pass

    assert events == [
        "start:https://paperless.example.com",
        "stop:stop-event:thread",
    ]

    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()


def test_create_app_skips_attachment_poller_without_paperless_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from family_ledger import config as config_module

    events: list[str] = []

    def fake_start(settings):
        events.append("start")
        return None

    monkeypatch.delenv("FAMILY_LEDGER_PAPERLESS_BASE_URL", raising=False)
    monkeypatch.delenv("FAMILY_LEDGER_PAPERLESS_TOKEN", raising=False)
    monkeypatch.setenv("FAMILY_LEDGER_ATTACHMENT_POLLER_ENABLED", "true")
    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()
    monkeypatch.setattr(
        "family_ledger.services.attachment_poller.start_attachment_poller",
        fake_start,
    )

    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)

    with TestClient(main_module.create_app()):
        pass

    assert events == ["start"]

    config_module.get_settings.cache_clear()
    config_module.get_ledger_config.cache_clear()
