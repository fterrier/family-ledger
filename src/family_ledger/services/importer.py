from __future__ import annotations

from typing import Any

import jsonschema
import jsonschema.exceptions
from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import ImporterResource, ListImportersResponse
from family_ledger.importers.base import ImportResult
from family_ledger.importers.registry import get_importer
from family_ledger.models.importer import Importer
from family_ledger.services.errors import NotFoundError, ValidationError
from family_ledger.services.validation import resource_name


def _serialize_importer(row: Importer) -> ImporterResource:
    importer_cls = get_importer(row.plugin_name)
    if importer_cls is not None:
        importer = importer_cls()
        display_name = importer.display_name
        importer_schema = importer.get_schema()
    else:
        display_name = row.plugin_name
        importer_schema = {}
    return ImporterResource.model_validate(
        {
            "name": row.name,
            "plugin_name": row.plugin_name,
            "display_name": display_name,
            "config": row.config,
            "schema": importer_schema,
        }
    )


def _validate_against_schema(config: dict[str, Any], schema: dict[str, Any]) -> bool:
    if not schema:
        return True
    try:
        jsonschema.validate(config, schema)
        return True
    except jsonschema.exceptions.ValidationError:
        return False


def _get_importer_row(session: Session, importer: str) -> Importer:
    resolved = resource_name("importers", importer)
    row = session.scalar(select(Importer).where(Importer.name == resolved))
    if row is None:
        raise NotFoundError(code="importer_not_found", message="Importer not found")
    return row


def list_importers(session: Session) -> ListImportersResponse:
    rows = session.scalars(select(Importer).order_by(Importer.plugin_name)).all()
    return ListImportersResponse(importers=[_serialize_importer(r) for r in rows])


def update_importer_config(
    session: Session,
    importer: str,
    config: dict[str, Any],
) -> ImporterResource:
    row = _get_importer_row(session, importer)
    importer_cls = get_importer(row.plugin_name)
    if importer_cls is not None:
        schema = importer_cls().get_schema()
        if schema and not _validate_against_schema(config, schema):
            raise ValidationError(
                code="invalid_config",
                message="Config does not match the importer schema",
            )
    row.config = config
    session.commit()
    session.refresh(row)
    return _serialize_importer(row)


def execute_import(
    session: Session,
    importer: str,
    file_data: bytes,
    config_override: dict[str, Any] | None,
) -> ImportResult:
    row = _get_importer_row(session, importer)
    importer_cls = get_importer(row.plugin_name)
    if importer_cls is None:
        raise NotFoundError(
            code="importer_not_installed",
            message=f"Importer '{row.plugin_name}' is not installed",
        )

    override = config_override or {}
    merged: dict[str, Any] = {**row.config, **override}
    schema = importer_cls().get_schema()

    if not _validate_against_schema(merged, schema):
        row.config = {}
        session.commit()
        merged = {**override}
        if not _validate_against_schema(merged, schema):
            raise ValidationError(
                code="invalid_config",
                message="Merged configuration does not match the importer schema",
            )

    return importer_cls().execute(session, file_data, merged)
