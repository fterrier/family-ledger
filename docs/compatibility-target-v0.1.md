# Family Accounting Platform Compatibility Target v0.1

## Purpose

Define what compatibility means for v1 so implementation decisions are constrained by an explicit contract.

Compatibility in this project means preserving accounting semantics and operational usefulness from the current workflow. It does not mean reproducing the current file layout, manual editing habits, or helper-script mechanics exactly.

## Replacement Target

The current workflow uses a Beancount ledger as the operational source of truth, plus supporting import and helper scripts and read-only tooling such as Fava.

The new system replaces that workflow with:
- a database-backed canonical ledger
- an API for reads, writes, imports, categorization, validation, and export
- deterministic Beancount export as the interoperability layer for read-only downstream tooling

Compatibility is judged by preserved ledger behavior and exported-ledger usefulness, not by preserving the single-file workflow itself.

## Compatibility Principles

- The database is the source of truth.
- Beancount is an export and validation target, not the runtime source of truth.
- Semantic equivalence matters; byte-for-byte text equivalence does not.
- Current workflow outcomes matter more than current file-editing mechanics.
- v1 should stay narrow, explicit, and boring.

## Required Semantic Coverage

The v1 system must preserve these behaviors:
- double-entry balancing
- Beancount-style account hierarchy semantics
- multi-currency postings and arbitrary commodities
- price history and price-based valuation support used by the current ledger
- balance assertions and project-level tolerance behavior
- account validity constraints via effective dates
- derived lot identity and strict cost-based matching for supported investment disposals
- deterministic full-ledger export accepted by read-only downstream tooling

### Account Validity

`open` and `close` are modeled internally as effective-date fields on accounts, not as required first-class runtime directive objects.

Compatibility requirement:
- a transaction referencing an account before its effective start date or after its effective end date must be rejected

### Lots

Supported investment use cases must preserve derived lot identity from held-at-cost postings.

Compatibility requirement:
- a disposal must use strict cost-based matching, not an implicit FIFO-only rule
- realized gains and losses must be derived from the matched lot or lots

In v1, lots are matched by commodity and per-unit cost only.

## Required Operational Coverage

The v1 system must preserve these workflow capabilities:
- imports can create balanced transactions directly in the ledger while preserving idempotent source identity
- uncategorized imported bank transactions can later be categorized
- categorization can split one imported transaction across multiple expense accounts
- current pension, transfer, salary, vesting, and investment flows remain representable as normal ledger entries
- exported ledger output remains usable by read-only Beancount tooling

### Categorization Meaning In v1

In v1, categorization is intentionally narrow.

It means:
- assigning an expense account to an uncategorized imported bank transaction
- splitting an imported bank transaction across multiple expense accounts

It does not imply a generic tagging system, a broad workflow engine, or a special transaction-type hierarchy.

## Canonical Data Model Interpretations

The following interpretations are part of the compatibility target for v1:

- Accounts have effective start and optional effective end dates.
- Attachments are the canonical replacement for document-style references in the internal data model.
- Transactions remain editable in v1.
- The API does not enforce field-level locking or restricted edit surfaces in v1.
- Client applications may expose narrower editing workflows, but that is a client choice, not a server-side compatibility guarantee.
- v1 does not require audit history or change logging.
- Imports use native IDs or fingerprints for idempotency rather than a separate staged import-item model.

## Full-Ledger Export Contract

v1 export scope is full ledger only.

Compatibility requirement:
- the system must export a deterministic full-ledger Beancount representation
- the export must preserve the accounting meaning of transactions, prices, balances, account validity rules, and derived held-at-cost lots
- the export is intended for read-only downstream tooling such as Fava
- unbalanced transactions may still appear in export; validation is a separate concern

v1 does not require filtered or partial export.

## Explicit Non-Goals

The v1 compatibility promise does not include:
- byte-for-byte reproduction of the reference Beancount file
- preservation of comments, placeholder markers, or file layout
- preservation of manual copy-and-paste import workflows
- preservation of direct ledger-file rewriting scripts
- write-back from Fava or other read-only Beancount tools
- field-level locking or edit restrictions
- audit trail or change logging
- filtered export

## Parity Testing Standard

Parity should be judged by semantic equivalence and downstream usability, not by text identity.

Representative parity fixtures should cover at least:
- ordinary uncategorized bank imports followed by categorization
- split expense categorization
- multi-currency transfers
- security buy and sell flows with strict cost-based lot matching
- vesting followed by sale
- pension commodities and balance assertions
- deterministic full-ledger export accepted by read-only tooling

## Deferred Beyond v1

These areas are intentionally deferred beyond v1:
- audit history and change logging
- locking and field-level edit restrictions
- filtered export
- richer reconciliation workflows
- governance-heavy approval workflows
