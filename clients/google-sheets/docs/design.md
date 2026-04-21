# Google Sheets Client Design

## Purpose

This document records the current design choices for the Google Sheets client.

## Supported Transaction Family

The client is intentionally narrow. It supports transactions with:
- exactly one source posting
- one or more destination postings
- one symbol across the transaction
- no cost or price data

This matches the current target workflow:
- bank/card outgoing categorization
- transfers to another account
- split allocation of one outgoing across multiple destinations

Unsupported transactions are skipped during sync rather than rendered into an ambiguous editing model.

## Sheet Model

The `Transactions` sheet is allocation-based.

- one normal outgoing can be represented as one row
- a split transaction is represented as multiple rows sharing the same `transaction_name`
- each row represents one final destination allocation

Columns:
- `transaction_name`
- `transaction_date`
- `payee`
- `narration`
- `source_account_name`
- `destination_account_name`
- `amount`
- `split_off_amount`
- `symbol`
- `status`
- `last_error`

Read-only columns:
- `transaction_name`
- `transaction_date`
- `source_account_name`
- `symbol`

Editable columns:
- `payee`
- `narration`
- `destination_account_name`
- `amount`
- `split_off_amount`

## Grouping And Ordering

Transaction rows are identified by `transaction_name`.

- contiguous grouping is preferred for readability
- the client tolerates non-contiguous rows by grouping on `transaction_name`
- current sheet row order becomes destination posting order on save
- sync preserves server order by default

## Split Behavior

Splitting is column-driven.

When the user enters a value in `split_off_amount`:
- the selected allocation row is split into two
- a new row is inserted below the edited row
- the new row gets the split amount
- the original row amount is reduced by the split amount
- the new row starts with the same `destination_account_name` as the original row

This keeps the user in-sheet and avoids prompt-based workflows as the primary interaction model.

## Save Behavior

The client auto-saves supported edits at the transaction level.

Edits that trigger save:
- `payee`
- `narration`
- `destination_account_name`
- `amount`
- `split_off_amount`

`payee` and `narration` are transaction-level fields, so editing them on one row propagates across all rows for the same `transaction_name` before save.

Saving always reconstructs the whole transaction for `PATCH /transactions/{transaction}`.

`Push Active Transaction` remains available only as a fallback manual retry path.

## Unsupported Transactions

Transactions outside the supported shape are skipped from the editable sheet.

This is a deliberate tradeoff:
- the client stays focused on the high-value categorization workflow
- the UI does not pretend to safely edit arbitrary posting graphs
- the sync summary makes the skipped subset visible to the user
