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

Persist derived issues as separate resources linked to stored entities.

Allow read APIs to include those persisted issues inline for convenience, while keeping canonical ledger state and diagnostics separate in storage.

## Consequences

Positive:
- Canonical ledger resources stay focused on source-of-truth data.
- Validation can evolve independently and at ledger scope.
- The model remains honest about the difference between canonical stored state and persisted diagnostics.
- Clients can read transaction data and persisted issues together without a second mandatory lookup.

Negative:
- Some invalid states can exist in the stored ledger until issues are consulted.
- The system now owns an additional persisted issue model and its lifecycle.
