# ADR 0009: Shared Single-Pass Balance Assertion Diffs

## Status

Accepted

## Context

Two features require computing account balances against stored balance assertions:

1. **`POST /ledger:doctor`** — checks every balance assertion in the ledger and surfaces failures as `balance_assertion_failed` issues.
2. **`GET /accounts/{account}:pad`** — computes the padding amount needed to satisfy the first upcoming balance assertion per currency for a given account.

An earlier implementation approach computed balances with per-assertion SQL aggregations (one `SUM(units_amount)` query per assertion). This was simple but scaled linearly with the number of assertions and did not share logic between doctor and pad.

## Decision

Implement a single shared function `compute_balance_assertion_diffs` (in `services/account_balance.py`) that walks transactions and balance assertions in chronological order in a single in-memory pass:

1. Load all relevant balance assertions ordered by `(assertion_date, name)`.
2. Load all relevant transactions with postings ordered by `(transaction_date, name)`.
3. Maintain a `running_balance: dict[account_name, dict[symbol, Decimal]]`.
4. For each assertion, lazily advance the transaction iterator to consume all transactions with `transaction_date < assertion_date`, updating running balances.
5. Compute `actual` by summing balances for the asserted account and all descendants.
6. Return a `BalanceAssertionDiff` per assertion.

The function is **pure** — it takes pre-loaded ORM objects and performs no DB queries. Call sites load data before calling:

- **`compute_pad`** filters to the relevant account subtree before calling.
- **`doctor_ledger`** passes all transactions (already loaded for other checks) and all balance assertions.

This design eliminates duplicate transaction loads when doctor reuses already-fetched data.

Non-leaf accounts work naturally: the descendant summation is identical whether the account is a leaf or a parent with children.

## Consequences

Positive:
- Doctor and pad share one implementation; balance assertion semantics (units-only, descendant inclusion, start-of-day cutoff) are defined in one place.
- The single-pass approach scales better for ledgers with many assertions than the per-assertion aggregation approach.
- Eager-loading transactions with their postings and accounts avoids N+1 query patterns.
- The pure function design means doctor can reuse already-loaded transactions without a second DB fetch.

Negative:
- All matching transactions are loaded into memory for the pass. For very large ledgers, a future process-level cache keyed on a ledger sequence number would reduce redundant DB round-trips on repeated doctor calls (deferred until profiling shows it is needed).
- The in-memory merge requires both result sets to be sorted consistently, which is enforced by the ORM queries.
