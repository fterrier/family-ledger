# ADR 0003: Validation Separation

## Status

Accepted

## Context

Validation in this system is broader than a single transaction row.

Some checks are local to one transaction, but others depend on:
- account effective dates
- accumulated balances
- cost-based lot matching over time
- balance assertions across the ledger
- future export and compatibility checks

Embedding validation fields directly into canonical transaction rows would mix source-of-truth data with derived diagnostics and would force validation design decisions too early.

## Decision

Allow unbalanced transactions to be persisted in v1.

Do not store validation fields such as error lists or convenience flags on canonical transaction rows themselves.

Expose ledger diagnostics through separate derived validation endpoints instead of persisting issue records.

## Consequences

Positive:
- Canonical ledger resources stay focused on source-of-truth data.
- Validation can evolve independently and at ledger scope.
- The model remains honest about the difference between canonical stored state and derived diagnostics.
- Ledger-relative checks can move freely when historical transactions change without any issue rewrite churn.

Negative:
- Some invalid states can exist in the stored ledger until diagnostics are consulted.
- Clients that want diagnostics must call a separate endpoint.
