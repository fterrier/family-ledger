# Account Balance And Pad

## Shared Basis

Balance assertion validation and pad computation share one chronological diff model.

The implementation walks transactions and balance assertions in order, maintaining running balances and computing assertion diffs from preloaded ledger data.

## `POST /ledger:doctor`

Doctor is a read-only reporting path.

Current checks include:

- unbalanced transaction issues
- FIFO lot replay failures for cost-tracked reductions (`lot_match_missing`)
- balance assertion failures (`balance_assertion_failed`)

Doctor issues are derived diagnostics. They do not mutate ledger state.

## `GET /accounts/{account}:pad`

Pad is also a read-only computation.

Given an account and date, it returns the postings that a synthetic pad transaction would need to satisfy the first upcoming balance assertion per currency after that date.

Current semantics:

- account subtree balances are included
- only future assertions after the requested date are considered
- one result entry may be returned per currency
- no ledger write-back happens automatically

## Cost-Tracked Accounts

Pad computation rejects currencies that would require padding a cost-tracked position.

This mirrors Beancount's restriction on padding cost-tracked accounts and keeps the API from implying a safe write path where none exists.

## Why It Was Implemented This Way

The shared diff approach keeps balance assertion semantics in one place and avoids separate implementations for doctor and pad.

That reduces semantic drift and keeps the reporting-only paths explicit.
