# ADR 0010: Pad Semantics

## Status

Accepted

## Context

The Beancount `pad` directive generates a synthetic balancing transaction that brings an account up to the amount asserted by the next `balance` directive. Several design questions arose when implementing the `GET /accounts/{account}:pad` endpoint and the corresponding Beancount importer phase 2.

The decisions below were verified against Beancount 3.2.0 behavior.

## Decisions

### 1. First balance assertion per currency only

A pad directive covers only the **first** balance assertion per currency that occurs strictly after the pad date. Later assertions for the same currency on that account are unaffected by the pad.

This matches Beancount behavior: Beancount generates exactly one synthetic transaction per currency and does not roll forward to satisfy subsequent assertions.

### 2. No cost annotation on pad entries

Synthetic pad transactions have no cost annotation. `PadEntry.units` contains only `amount` and `symbol`; there is no `cost` field.

Beancount does not support cost-annotated balance directives, and it raises an error ("Attempt to pad an entry with cost for balance") when a `pad` directive targets an account with cost-tracked positions. The API enforces the same constraint: if any posting on the account subtree for the asserted currency has `cost_symbol IS NOT NULL` and `transaction_date < assertion_date`, the endpoint returns `ValidationError(code=pad_cost_tracked_account)`.

### 3. Non-leaf account support

Padding a non-leaf account is fully supported. The pad amount is computed as `assertion_amount − sum(balance for account + all descendants)`, identical to how balance assertions on parent accounts work. The synthetic transaction posts to the padded account itself, not distributed to children.

### 4. Per-currency source_native_id in the importer

When the Beancount importer processes a `pad` directive, it creates one synthetic transaction per currency returned by `compute_pad`. Each transaction carries a `source_native_id` of the form `beancount:pad:{account}:{date}:{symbol}`. This ensures idempotency: on re-import, the presence of any per-currency pad transaction for a given directive is detected via a `LIKE` prefix query, and the entire directive is skipped as a duplicate.

## Consequences

Positive:
- Pad semantics match Beancount 3.2.0 behavior.
- Cost-tracked accounts are rejected early with a clear error code, preventing silent data corruption.
- Per-currency idempotency keys allow multi-currency pad directives to be imported and re-imported safely.

Negative:
- The cost-tracked check (SQL COUNT per currency) adds one query per asserted currency per pad directive. This is acceptable given that pad directives and balance assertions are typically a small fraction of ledger entries.
