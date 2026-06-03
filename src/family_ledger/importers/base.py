from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from family_ledger.config import Settings


class EntityErrors(BaseModel):
    count: int = 0
    examples: list[str] = Field(default_factory=list)


class EntityCounts(BaseModel):
    created: int = 0
    duplicate: int = 0
    errors: EntityErrors = Field(default_factory=EntityErrors)


class ImportResult(BaseModel):
    entities: dict[str, EntityCounts] = Field(default_factory=dict)
    created_resources: dict[str, list[str]] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class BaseImporter(ABC):
    name: str
    display_name: str

    def get_schema(self) -> dict[str, Any]:
        return {}

    def get_file_descriptors(self) -> list[dict[str, Any]]:
        return [
            {"name": "file", "label": "File", "description": "", "accept": [], "required": True}
        ]

    @abstractmethod
    def execute(
        self,
        session: Session,
        files: dict[str, bytes],
        config: dict[str, Any],
        settings: Settings | None = None,
    ) -> ImportResult: ...
