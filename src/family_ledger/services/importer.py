from __future__ import annotations

import json
from typing import Any

import jsonschema
import jsonschema.exceptions
from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import ImporterResource, ListImportersResponse
from family_ledger.config import Settings
from family_ledger.importers.base import ImportContext, ImportResult
from family_ledger.importers.registry import get_importer, get_importers
from family_ledger.models.importer import Importer
from family_ledger.services.errors import NotFoundError, ValidationError


def _serialize_importer(
    plugin_name: str,
    config: dict[str, Any],
) -> ImporterResource:
    importer_cls = get_importer(plugin_name)
    if importer_cls is not None:
        importer = importer_cls()
        display_name = importer.display_name
        importer_schema = importer.get_schema()
        file_descriptors = importer.get_file_descriptors()
    else:
        display_name = plugin_name
        importer_schema = {}
        file_descriptors = []
    return ImporterResource.model_validate(
        {
            "name": "importers/" + plugin_name,
            "plugin_name": plugin_name,
            "display_name": display_name,
            "config": config,
            "schema": importer_schema,
            "file_descriptors": file_descriptors,
        }
    )


def _validate_against_schema(
    config: dict[str, Any], schema: dict[str, Any]
) -> jsonschema.exceptions.ValidationError | None:
    if not schema:
        return None
    try:
        jsonschema.validate(config, schema)
        return None
    except jsonschema.exceptions.ValidationError as exc:
        return exc


def _validate_importer_config(config: dict[str, Any], schema: dict[str, Any]) -> None:
    exc = _validate_against_schema(config, schema)
    if exc is None:
        return
    raise ValidationError(
        code="invalid_config",
        message=f"Config does not match the importer schema: {exc.message}",
    )


def _resolve_importer_config(
    stored_config: dict[str, Any],
    config_override: dict[str, Any] | None,
    schema: dict[str, Any],
) -> dict[str, Any]:
    resolved_config = {**stored_config, **(config_override or {})}
    _validate_importer_config(resolved_config, schema)
    return resolved_config


def _load_stored_config(session: Session, plugin_name: str) -> dict[str, Any]:
    row = session.scalar(select(Importer).where(Importer.plugin_name == plugin_name))
    return row.config if row is not None else {}


def _parse_config_override(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValidationError(
            code="invalid_config_override",
            message="config_override is not valid JSON",
        ) from exc
    if not isinstance(parsed, dict):
        raise ValidationError(
            code="invalid_config_override",
            message="config_override must be a JSON object",
        )
    return parsed


def list_importers(session: Session) -> ListImportersResponse:
    rows = {row.plugin_name: row.config for row in session.scalars(select(Importer)).all()}
    importers = [
        _serialize_importer(plugin_name, rows.get(plugin_name, {}))
        for plugin_name in sorted(get_importers())
    ]
    return ListImportersResponse(importers=importers)


def update_importer_config(
    session: Session,
    plugin_name: str,
    config: dict[str, Any],
) -> ImporterResource:
    importer_cls = get_importer(plugin_name)
    if importer_cls is None:
        raise NotFoundError(code="importer_not_found", message="Importer not found")
    _validate_importer_config(config, importer_cls().get_schema())
    row = session.scalar(select(Importer).where(Importer.plugin_name == plugin_name))
    if row is None:
        row = Importer(plugin_name=plugin_name, config=config)
        session.add(row)
    else:
        row.config = config
    session.commit()
    session.refresh(row)
    return _serialize_importer(plugin_name, row.config)


def execute_import(
    session: Session,
    plugin_name: str,
    files: dict[str, bytes],
    config_override_raw: str | None,
    settings: Settings | None = None,
) -> ImportResult:
    importer_cls = get_importer(plugin_name)
    if importer_cls is None:
        raise NotFoundError(
            code="importer_not_found",
            message=f"Importer '{plugin_name}' is not installed",
        )
    importer = importer_cls()
    stored_config = _load_stored_config(session, plugin_name)
    config_override = _parse_config_override(config_override_raw)
    merged = _resolve_importer_config(stored_config, config_override, importer.get_schema())
    ctx = ImportContext(session, settings)
    return importer.execute(ctx, files, merged, settings)
