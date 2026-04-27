# ADR 0008: Monolithic Modular Import System

## Status

Accepted

## Context

The system needs to support multiple external file formats (e.g., Beancount, MT940, PDF
payslips) and map them into the canonical database ledger format.

A webhook/microservice architecture was considered first: each importer would be a standalone
service that the ledger calls over HTTP via NDJSON streaming. This approach was rejected
because it introduces significant operational complexity (multiple containers, health
polling, registration loops, network security) that is disproportionate to the actual
problem. The webhook architecture is preserved as a reference idea at
`docs/future_ideas/modular-import-system-v0.1.md`.

## Decision

1. **Monolithic Python Importers**: Importers are standard Python classes inheriting from a
   `BaseImporter` abstract class. The integration boundary lives in
   `src/family_ledger/importers/`. Importer implementations live in a separate local
   package at `importers/` that can be split into its own repository later.

2. **Dependency Isolation via Entry Points**: The `importers/` package has its own
   `pyproject.toml` and declares its importers using the standard Python entry points
   mechanism under the `family_ledger.importers` group. The main application discovers
   them via `importlib.metadata.entry_points()` at startup. No uv workspace constructs
   are used; `pip install ./importers` is sufficient.

3. **One-Step Execute**: Each importer implements a single
   `execute(session, file_data, config) -> ImportResult` method that both parses input
   and writes to the database. There is no intermediate parse-then-import split. This
   gives importers full control over which entity types they create.

4. **Idempotency Contract**: Imports do not use a single atomic commit. Instead, importers
   must be idempotent: re-running an import must produce the same result without creating
   duplicates. Each importer handles `ConflictError` per entity and counts those as
   duplicates. This extends the create-or-skip contract from ADR 0004 to all entity types.

5. **Database Configuration**: A new `Importer` SQLAlchemy model stores the persistent
   user configuration (`config` JSONB) for an importer. `display_name` is not stored; it
   is defined on the importer class and injected at query time.

6. **Auto-Bootstrap (1:1 Mapping)**: On application startup, the system scans the entry
   point registry and creates exactly one `Importer` DB row per discovered importer. If the
   importers package is not installed, startup succeeds with zero importers. Orphaned rows
   from removed importers are not cleaned up automatically.

7. **AIP-Compliant Endpoints**: The system exposes `GET /importers`, `PATCH
   /importers/{importer}`, and `POST /importers/{importer}:import`. Resource naming
   follows AIP-122 using the `imp` prefix (e.g., `importers/imp_12345`).

## Consequences

- **Pros**: Single container deployment. The UI can query `GET /importers` to retrieve
  each importer's JSON schema and render dynamic config forms. Importers are independently
  packageable and forward-compatible with a 1:N profile model. Standard Python plugin
  mechanism works everywhere without uv-specific tooling.
- **Cons**: A segfault in an underlying C-library (e.g., a buggy PDF text parser) crashes
  the main ledger process. This risk is accepted in exchange for the vastly reduced
  operational complexity. Orphaned DB rows accumulate silently when importers are removed.
