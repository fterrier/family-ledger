# Importers

## Adding Or Changing An Importer

Importers live in the separate `importers/` package and are discovered through the `family_ledger.importers` entry point group.

When changing importer behavior:

- keep plugin identity stable; API resource names are derived from `plugin_name`
- keep stored config sparse
- validate config through the importer schema
- preserve create-or-skip import behavior unless the product contract changes
- preserve import lineage through `source_native_id`

## Files To Review

- importer implementation under `importers/src/`
- `src/family_ledger/importers/registry.py`
- `src/family_ledger/services/importer.py`
- `src/family_ledger/api/importer.py`
- `docs/specs/import-system.md`

## Verification

- run backend tests covering importer routes and service behavior
- if the schema or user-facing config changes, update the Sheets importer spec if relevant
