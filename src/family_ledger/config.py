from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class LedgerConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    default_currency: str = Field(default="CHF")
    tolerance: dict[str, str] = Field(default_factory=dict)
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
    database_url: str = "postgresql+psycopg://family_ledger:family_ledger@postgres:5432/family_ledger"
    ledger_config_path: Path = Path("config/ledger.yaml")


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
    return Settings()


@lru_cache(maxsize=1)
def get_ledger_config() -> LedgerConfig:
    settings = get_settings()
    return LedgerConfig.model_validate(_load_yaml_config(settings.ledger_config_path))
