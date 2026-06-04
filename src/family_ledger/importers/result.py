from __future__ import annotations

from pydantic import BaseModel, Field


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
