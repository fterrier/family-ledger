# Beancount Import Bootstrap v0.1

## Purpose

Define the scope and behavior of the initial Beancount importer.

This importer exists to answer one question first:

- can the current database-backed ledger model represent the existing Beancount ledger without losing required accounting semantics?

It is a compatibility/bootstrap tool, not a general long-term ingestion workflow.

## Target Input

The initial target is the reference Beancount ledger currently used to validate compatibility.

The importer should be designed around the constructs actually used there before trying to support broader Beancount projects.

## Primary Goals

- load the current Beancount ledger into an empty database
- verify that the current schema can hold the existing ledger semantics
- surface unsupported or ambiguous constructs early
- provide a populated local database for parity testing and exploration

## Non-Goals

The initial importer is not intended to be:

- an incremental sync tool
- an overwrite or merge tool
- a generic import path for arbitrary Beancount repositories
- the normal runtime import path for day-to-day usage
- a replacement for the later export-parity work

## Operational Model

The importer should operate under these rules:

- empty database only
- create-only
- no overwrite behavior
- no in-place merge behavior
- fail at the end with a complete report if unsupported constructs are encountered

If the database already contains ledger data, the importer should stop rather than trying to merge imported state with existing rows.

## Parser Strategy

Use Beancount's own parser/loader if feasible.

Rationale:
- avoids writing a custom parser prematurely
- reduces syntax-handling risk
- keeps the work focused on semantic mapping into the database model

A custom parser should be avoided unless the Beancount parser proves impractical for the target workflow.

## Initial Supported Constructs

The initial importer should support:

- `open`
- `close`
- `commodity`
- transactions and postings
- `price`
- `balance`

For the reference ledger, `option` directives should be handled minimally:

- options that map directly to project config should be reported or compared
- options that do not affect canonical storage may be ignored explicitly

For commodity handling, the importer should pre-discover symbols from the input ledger and create missing commodity rows before importing transactions, prices, and assertions. This avoids weakening the stricter runtime API validation for normal writes.

## Initial Unsupported Behavior

The importer may initially reject or report, rather than import:

- directives not currently used by the existing ledger
- constructs that do not map cleanly onto the v1 schema
- ambiguous cases where current schema behavior would be unclear

Unsupported constructs should be collected into a report rather than failing on the first one.

## Normalization Boundary

The importer should use the same shared transaction normalization logic as the API rather than inventing separate interpolation rules.

That shared normalization currently follows Beancount balancing-weight semantics:
- units only -> balance on units
- price without cost -> balance on price
- cost present -> balance on cost
- cost and price -> cost wins for balancing

The initial supported interpolation scope remains narrow:
- at most one posting with missing `units`
- at most one posting with a missing `units.symbol`
- one or more resulting balancing weights, provided the balancing weights are explicit and unambiguous
- at most one posting per balancing symbol group with missing `price.amount`

Transactions outside that scope should be skipped and reported rather than approximated.

## Reporting Behavior

The importer should produce a summary including at least:

- accounts imported
- commodities imported
- transactions imported
- prices imported
- balance assertions imported
- unsupported constructs encountered
- skipped items and why they were skipped

This importer is a compatibility-discovery tool first, so issue reporting matters as much as successful inserts.

## Success Criteria

The initial importer is successful if it can:

- import the current Beancount ledger into an empty database
- report all unsupported constructs in one run
- populate the canonical storage model with the expected data types
- provide a seeded database that can be queried locally
- inform the next round of export and parity work

## Follow-On Questions

Implementation of the importer should help answer:

- whether the current account/effective-date model is sufficient
- whether transaction and posting storage is complete enough for the reference ledger
- whether current price and assertion support is sufficient
- whether investment and held-at-cost semantics need extension before parity export is attempted
- whether current option/config handling needs to become stricter
