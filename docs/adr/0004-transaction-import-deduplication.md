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

Transactions store dedupe fields:
- source native ID
- fingerprint

The API may group these fields under nested `import_metadata`, while the database keeps them flattened for queryability and uniqueness constraints.

Matching priority is:
1. native ID
2. fingerprint

Imports are create-or-skip only in v1 and do not overwrite existing matching transactions.

## Consequences

Positive:
- Import behavior stays simple and close to the transaction model.
- Re-import remains idempotent without introducing staged import entities.
- Querying and uniqueness constraints remain straightforward in the database.

Negative:
- The project does not get a full provenance/history model in v1.
- Import workflow state is intentionally limited.
- If replacement or richer import review is needed later, the model may need to expand.
