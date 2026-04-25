# ADR 0007: Doctor Lot Booking

## Status

Accepted

## Context

The project originally experimented with persisting issue records and with a derived `inventory_negative` diagnostic.

That approach proved misleading for lot/cost validation:
- `inventory_negative` did not match observed Beancount behavior on real ledger examples such as vesting transactions
- persisted issue rows added write-time churn for ledger-relative diagnostics
- standard transaction reads were becoming overloaded with derived state

At the same time, the project still needs a derived ledger check for held-at-cost postings.

## Decision

Expose lot-booking diagnostics only through `POST /ledger:doctor`.

Implement one v1 lot-booking issue code:
- `lot_match_missing`

Implement the check by replaying exact lot buckets with FIFO:
- lot identity in v1 is `account + units_symbol + cost_symbol + cost_per_unit`
- postings in the same transaction and same exact lot bucket are aggregated before booking checks
- if a transaction delta needs to consume more opposite-side quantity than is available in the FIFO queue, emit `lot_match_missing`

Do not persist these diagnostics.

Run `ledger:doctor` in a read-only database transaction so it remains a reporting path and does not take write locks on normal ledger mutations.

Structure the implementation so booking policy is replaceable later.

Keep the replay logic in a dedicated booking component instead of embedding it in ledger doctor code.
That component should also be reusable for future inventory-style projections if they are added.

## Consequences

Positive:
- The implemented diagnostic matches observed FIFO-style examples better than `inventory_negative`
- Canonical transaction reads remain free of derived diagnostics
- The replay engine can later support additional Beancount-like booking methods
- Doctor and any future inventory projection can share the same replay logic instead of reimplementing reductions twice
- Future work can extend lot identity with date or label without redesigning the whole endpoint

Negative:
- The v1 lot-booking check is still only an approximation of full Beancount booking behavior
- The current implementation does not support per-account booking methods
- Lot identity still omits date and label in v1, so some Beancount distinctions remain out of scope
