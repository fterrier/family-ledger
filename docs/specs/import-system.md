# Import System

## Purpose

Imports let the ledger ingest external files directly into canonical database state while preserving importer-specific configuration and idempotent deduplication.

## Discovery Model

Importers are installed Python plugins discovered through the `family_ledger.importers` entry point group.

- importer availability comes from installed entry points
- the API does not bootstrap importer rows at app startup
- `GET /importers` only returns currently installed importer plugins

## Importer Identity

Importer resource names are derived from the plugin name.

- API resource: `importers/{plugin_name}`
- persistent DB key: `plugin_name`

There is one persistent config row per plugin name.

## Config Model

Importer plugins define:

- `display_name`
- JSON Schema returned by `get_schema()`

The service stores only sparse persistent config values explicitly chosen by the user. Blank or absent values remain absent instead of being expanded to schema defaults in storage.

## Runtime Resolution

At import time the service:

1. loads stored config for the plugin
2. merges it with any one-off `config_override`
3. validates the merged object against the importer schema
4. executes the importer synchronously

The stored row is not automatically rewritten during import.

## Import Contract

Current importer behavior is create-or-skip.

- imports may create canonical ledger entities
- duplicates should be skipped rather than overwritten
- import lineage is tracked through `source_native_id`
- the system favors idempotent re-runs over destructive sync behavior

## API Surface

- `GET /importers`: list installed importer plugins with display name, sparse stored config, and runtime schema
- `PATCH /importers/{importer}`: replace stored config for that importer after schema validation
- `POST /importers/{importer}:import`: upload a file and run the importer synchronously

## Special Beancount Metadata Fields

The beancount importer reserves two metadata keys that receive special treatment rather than
being stored as-is in `entity_metadata`.

| Key | Directive | Meaning |
|-----|-----------|---------|
| `source_native_id` | Transaction | Deduplication key for the transaction. When present it is used directly as the `source_native_id` instead of deriving one from a `ref` field or falling back to a content hash. |
| `document_url` | Document | URL of an already-stored backend document. When present the importer creates the attachment in `stored` status directly, without uploading a file or requiring Paperless to be configured. |

These fields are emitted by the beancount exporter so that a round-trip (export → re-import)
produces only duplicates and no new records.

All other metadata on a directive is stored verbatim in `entity_metadata["beancount"]` and
re-emitted on export, preserving round-trip fidelity for arbitrary importer-specific fields.

## Why It Works This Way

The model is intentionally narrow:

- no staged import-item subsystem
- no asynchronous orchestration layer
- no importer profile creation API separate from plugin identity

That keeps import behavior close to canonical ledger writes and makes importer configuration easy for clients such as the Google Sheets UI to present.
