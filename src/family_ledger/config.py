from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class LedgerConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    default_currency: str = Field(default="CHF")
    default_tolerance: Decimal
    tolerance: dict[str, Decimal] = Field(default_factory=dict)
    uncategorized_accounts: list[str] = Field(default_factory=list)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="FAMILY_LEDGER_",
        env_file=".env",
        extra="ignore",
    )

    app_env: str = "development"
    host: str = "0.0.0.0"
    port: int = 8000
    api_token: str
    database_url: str | None = None
    db_host: str = "postgres"
    db_port: int = 5432
    db_name: str = "family_ledger"
    db_user: str = "family_ledger"
    db_password: str | None = None
    ledger_config_path: Path = Path("config/ledger.yaml")
    paperless_base_url: str | None = None
    paperless_token: str | None = None
    paperless_api_version: int = 10
    paperless_poll_interval_seconds: int = 30
    paperless_ingestion_timeout_seconds: int = 900
    attachment_poller_enabled: bool = True

    def get_database_url(self) -> str:
        if self.database_url is not None:
            return self.database_url
        if self.db_password is not None:
            from urllib.parse import quote_plus

            return f"postgresql+psycopg://{self.db_user}:{quote_plus(self.db_password)}@{self.db_host}:{self.db_port}/{self.db_name}"
        return f"postgresql+psycopg://{self.db_user}:@{self.db_host}:{self.db_port}/{self.db_name}"

    def paperless_is_configured(self) -> bool:
        return self.paperless_base_url is not None and self.paperless_token is not None


def _load_yaml_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Ledger config file not found: {path}")

    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}

    if not isinstance(data, dict):
        raise ValueError(f"Ledger config file must contain a mapping: {path}")

    return data


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]


@lru_cache(maxsize=1)
def get_ledger_config() -> LedgerConfig:
    settings = get_settings()
    return LedgerConfig.model_validate(_load_yaml_config(settings.ledger_config_path))
