# Product Scope

## Purpose

`family-ledger` is a self-hosted, DB-backed, API-first accounting system that preserves Beancount-like ledger semantics while moving the canonical source of truth from a text file to PostgreSQL.

## Current Feature Set

The current implementation provides:

- canonical storage for accounts, commodities, prices, transactions, postings, balance assertions, and importer configuration
- canonical storage for account-linked attachments whose binaries are stored through an external document backend
- authenticated FastAPI routes for ledger reads, writes, updates, deletes, normalization, diagnostics, and imports (accounts, commodities, transactions, balance assertions, and attachments all support PATCH and DELETE)
- derived ledger diagnostics through `POST /ledger:doctor` (7 check types: unbalanced, account effectiveness, unknown commodity, lot matching, balance assertion, and two attachment states)
- on-demand pad computation through `GET /accounts/{account}:pad`
- synchronous file import through installed importer plugins; importers may declare multiple named file inputs via `file_descriptors`
- deterministic full-ledger Beancount export through the `export-beancount` CLI, including `document` directives for stored attachments
- a Google Sheets client for transaction review, categorization, splitting, entity CRUD (accounts, balance assertions, commodities, attachments, transactions), quick filter, and importer workflows

## Compatibility Target

The project aims to preserve the accounting behavior and operational usefulness of the prior Beancount-based workflow, not its file-editing mechanics.

Current compatibility commitments:

- double-entry transaction semantics
- Beancount-style account hierarchy and effective-date constraints
- multi-currency transactions and arbitrary commodity symbols
- stored prices and balance assertions
- import lineage and idempotent import deduplication via `source_native_id`
- deterministic Beancount export suitable for read-only downstream tools such as Fava

## Deliberate Product Shape

The database is the source of truth.

- API writes target canonical database state directly
- Beancount is an export and interoperability format, not runtime storage
- derived diagnostics are exposed separately from canonical stored rows
- clients may offer narrower workflows than the API, but Sheets is not the source of truth

## Current Non-Goals

The current project does not aim to provide:

- period locking or audit-history workflows
- spreadsheet-as-source-of-truth behavior
- a broad reconciliation subsystem
- asynchronous import orchestration or staged import item models
- generic spreadsheet-first editing for every ledger shape in the Google Sheets client
- field-level API edit restrictions to mirror client limitations

## Deferred Scope

These areas are explicitly deferred rather than part of the current contract:

- automatic pad write-back into the ledger
- richer booking methods beyond FIFO diagnostics in doctor
- HTTP export endpoints; export is currently CLI-driven
- a dedicated first-party web UI
