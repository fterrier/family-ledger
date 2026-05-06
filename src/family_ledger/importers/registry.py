from __future__ import annotations

from importlib.metadata import entry_points

from family_ledger.importers.base import BaseImporter

_importers: dict[str, type[BaseImporter]] | None = None


def get_importers() -> dict[str, type[BaseImporter]]:
    global _importers
    if _importers is None:
        _importers = {ep.name: ep.load() for ep in entry_points(group="family_ledger.importers")}
    return _importers


def get_importer(plugin_name: str) -> type[BaseImporter] | None:
    return get_importers().get(plugin_name)
