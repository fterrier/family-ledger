# ADR 0004: Transaction Import Deduplication

## Status

Accepted

## Context

The system needs imports that are idempotent and practical, but the team wants to avoid a heavy staged-import subsystem in v1.

Several alternatives were considered:
- staged import jobs and import items
- richer provenance models on all entities
- importer-owned revisions or audit-heavy workflows

Those options add lifecycle and schema complexity quickly.

The real v1 need is narrower:
- identify matching imported transactions on re-import
- avoid creating duplicates
- keep import behavior simple and non-destructive

## Decision

Imports operate directly on transactions in v1.

Each importer assigns a stable, namespaced `source_native_id` to every transaction it creates. The format is `"{importer}:{stable_id}"`, for example `"mt940:Z1234"` or `"beancount:fp:sha256:..."`. This field is the single deduplication key — a partial unique index (`WHERE source_native_id IS NOT NULL`) enforces uniqueness in the database.

When an importer has access to a bank-assigned or file-level reference it uses it directly (e.g. `"mt940:Z1234"`, `"beancount:Z1234"`). When no such reference exists, the importer computes a deterministic hash of key transaction fields plus an occurrence index — how many times an identical-looking transaction has already appeared in the same import batch. This makes the ID stable across re-imports of the same file while handling multiple genuinely identical transactions on the same day.

The `source_native_id` prefix is importer-specific to prevent cross-importer ID collisions.

Imports are create-or-skip only in v1 and do not overwrite existing matching transactions.

## Consequences

Positive:
- Import behavior stays simple and close to the transaction model.
- Re-import remains idempotent without introducing staged import entities.
- A single field serves as the dedupe key; no priority fallback logic needed.
- Namespacing prevents collisions between importers sharing similar native references.

Negative:
- The project does not get a full provenance/history model in v1.
- Import workflow state is intentionally limited.
- When two overlapping statements each contain a distinct transaction with identical fields (date, amount, currency, account) and no bank-assigned reference, the second import will treat the transaction as a duplicate and skip it. This is a known limitation of the occurrence-index approach.
- If replacement or richer import review is needed later, the model may need to expand.
