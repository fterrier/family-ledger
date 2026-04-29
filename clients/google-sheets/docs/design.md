# Google Sheets Client Design

## Purpose

This document records the current design choices for the Google Sheets client.

## Supported Transaction Family

The client classifies transactions by account type, not by posting sign.

**Source selection:**
- The source posting is the Assets or Liabilities posting (marker `[A]` or `[L]`).
- When multiple balance-sheet accounts exist, the one with a negative amount is preferred (so that destination amounts appear positive — e.g. a transfer from Checking to Savings).
- If no balance-sheet account is found, the fallback is the single negative posting (classic rule). If there is still no unambiguous source, the transaction is rejected.

**Destination postings:**
- All postings other than the source are destinations.
- Destination amounts are written to the sheet as-is and may be negative. A negative destination amount naturally arises for income transactions, where an Income account (negative Beancount balance) is the destination and the bank is the source.

**Amount display:**
- For source-only transactions (no destinations): the displayed amount is the absolute value of the source posting.
- For zero-posting transactions: a placeholder row is rendered with blank financial fields.

**Accepted shapes:**
| Shape | Source | Destinations | Notes |
|---|---|---|---|
| Normal spending | `[A]Bank −X` | `[X]Expense +X` | amount positive |
| Income | `[A]Bank +X` | `[I]Salary −X` | amount negative |
| Transfer | `[A]Checking −X` | `[A]Savings +X` | negative balance-sheet preferred |
| Source-only | single balance-sheet posting | none | blank destination row |
| Zero postings | none | none | placeholder row |
| Multi-destination | one balance-sheet | many | split model |

**Rejected shapes:**
- Two positive flow-account postings with no balance-sheet account (ambiguous source)
- Mixed symbols
- Postings with cost or price data

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
- `symbol`
- `amount`
- `split_off_amount`
- `status`
- `issues`
- `last_error`

For readability, visible account names are rendered as shortened labels with root markers, for example:
- `[A] Bank - Checking - Family`
- `[L] CreditCard - Visa`
- `[X] Food - Groceries`

The client keeps the hidden technical transaction key and resolves edited destination values back to canonical account resources through the synced accounts lookup.

Read-only columns:
- `transaction_name`
- `transaction_date`
- `source_account_name`
- `symbol`

`transaction_name` remains the technical grouping key but is hidden from normal users in the sheet UI.
`issues` is visible to users.
`last_error` is kept hidden as a technical troubleshooting field next to `status`.

Editable columns:
- `payee`
- `narration`
- `destination_account_name`
- `amount`
- `split_off_amount`

The transaction sheet also uses visual role cues:
- read-only columns are shaded neutrally
- editable columns keep a clean editable background
- `split_off_amount` is styled as an action column

For imported transactions, `amount` is an allocation amount, not an editable transaction total.

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

If the user enters `x` or `-` in `split_off_amount`:
- the selected split row is deleted
- its amount is merged into a sibling row
- the imported transaction total remains unchanged

If the helper command is invalid:
- the `split_off_amount` cell is cleared immediately
- no save is attempted

This keeps the user in-sheet and avoids prompt-based workflows as the primary interaction model.

Direct `amount` edits for imported transactions follow the same invariant:
- any change (increase or decrease) creates a split for the difference
- the two resulting pieces must sum to the original; neither may be zero
- a degenerate edit (new amount equals original, or new amount equals zero) is rejected
- split amounts may cross sign boundaries: a positive `split_off_amount` on a negative-amount row is valid if neither resulting piece is zero, and vice versa

For source-only transactions:
- the transaction renders as one row with a blank destination account
- setting a destination account creates the second posting on save
- deleting the last destination row returns the transaction to source-only state
- direct `amount` edits are rejected
- split commands are rejected

## Quick Filter Sidebar

`Family Ledger → Quick Filter` opens a persistent sidebar. It applies a native Google Sheets `BasicFilter` with `whenFormulaSatisfied()` criteria to the transaction sheet without altering any data.

**Date filter:**
- Year buttons select a contiguous range of years; clicking the same year twice deselects it.
- Month pickers set an arbitrary `YYYY-MM` range.
- Year buttons and month pickers stay in sync: selecting a year range sets the month inputs to January–December of that range.
- The filter applies a regex on the `transaction_date` column.

**Account filter:**
- A cascading set of dropdowns navigates the account hierarchy (type → sub-account → ...).
- The applied formula is an OR across both the `source_account_name` and `destination_account_name` columns, so a row is included if either account matches.
- At the type level, `LEFT(E2,4)="[X] "` style matching is used.
- At sub-levels, both exact-match and prefix-match clauses are OR-ed to include the account itself and all its children.
- The `No account set` option filters for rows with a blank destination account using `=F2=""`.

**Persistence:**
- The active filter is stored in Google Sheets document properties (`QUICK_FILTER_FROM`, `QUICK_FILTER_TO`, `QUICK_FILTER_ACCOUNT_PREFIX`).
- On sidebar open, the persisted state is fetched in a single `getQuickFilterSidebarData()` call alongside the available years and account names.

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

For refreshed transactions:
- if the server-rendered rows already match the current local rows, the client skips row rewrites entirely and only updates transient status/error fields
- same-shape responses are applied in place without deleting and recreating rows
- structural row replacement is reserved for true shape changes, such as a changed rendered row count
- stale save responses must not overwrite newer local edits
- ledger doctor issues are rendered in the visible `issues` column
- rows with doctor issues are highlighted light red across the full row
- transient save failures update hidden `last_error` and `status=error` without using the doctor-issue highlight
- the client refreshes `ledger:doctor` asynchronously after sync and after each successful save

`Push Active Transaction` remains available only as a fallback manual retry path.

## Unsupported Transactions

Transactions outside the supported shape are skipped from the editable sheet.

This is a deliberate tradeoff:
- the client stays focused on the high-value categorization workflow
- the UI does not pretend to safely edit arbitrary posting graphs
- the sync summary makes the skipped subset visible to the user
