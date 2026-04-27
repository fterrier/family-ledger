from __future__ import annotations

from importlib.metadata import entry_points

from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.importers.base import BaseImporter
from family_ledger.models.importer import Importer
from family_ledger.services.identifiers import generate_resource_name

_importers: dict[str, type[BaseImporter]] | None = None


def get_importers() -> dict[str, type[BaseImporter]]:
    global _importers
    if _importers is None:
        _importers = {ep.name: ep.load() for ep in entry_points(group="family_ledger.importers")}
    return _importers


def get_importer(plugin_name: str) -> type[BaseImporter] | None:
    return get_importers().get(plugin_name)


def bootstrap_importers(session: Session) -> None:
    for plugin_name in get_importers():
        existing = session.scalar(select(Importer).where(Importer.plugin_name == plugin_name))
        if existing is None:
            session.add(
                Importer(
                    name=generate_resource_name("importers", "imp"),
                    plugin_name=plugin_name,
                    config={},
                )
            )
    session.commit()
