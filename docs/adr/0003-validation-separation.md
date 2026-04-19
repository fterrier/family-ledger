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

Embedding validation state directly into canonical transaction resources would mix source-of-truth data with derived diagnostics and would force validation design decisions too early.

## Decision

Allow unbalanced transactions to be persisted in v1.

Do not embed validation state such as error lists or convenience flags into canonical transaction resources.

Treat validation as a separate concern and design a dedicated validation API later.

## Consequences

Positive:
- Canonical ledger resources stay focused on source-of-truth data.
- Validation can evolve independently and at ledger scope.
- The model remains honest about the difference between persisted state and computed diagnostics.

Negative:
- Clients that want validation status must call separate validation functionality later.
- Some invalid states can exist in the stored ledger until validation is consulted.
