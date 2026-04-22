# Google Sheets Client Performance

## Target

This client must remain workable on large sheets with many thousands of rows.

The current benchmark case is roughly `9k` transaction rows.

## Performance Rules

### Full Rebuilds

Only full sync actions may rebuild the whole transaction sheet.

Allowed full rebuild path:
- `Sync Transactions`

### Hot Paths

Edit-driven and active-row operations must stay transaction-local.

These paths should:
- locate rows by `transaction_name`
- read only the relevant rows or columns
- write only the affected rows or columns
- avoid full-sheet rewrites

Important hot paths:
- payee/narration propagation
- split handling
- auto-save
- fallback manual push

For same-shape saves:
- if the current local rows already match the server-rendered rows, skip row rewrites entirely
- do not delete and recreate rows
- update changed cells in place only

Structural row replacement is allowed only when the rendered transaction shape actually changes.

### Validation And Protection

Do not rebuild validation or sheet protections for the entire sheet during hot-path actions.

Instead:
- apply validation only to touched rows where possible
- leave protection setup to sync/setup paths unless structure changes require an adjustment

## Why This Matters

Apps Script becomes noticeably slow if a single-cell edit triggers:
- a full-sheet read
- a full-sheet rewrite
- full validation reapplication
- full protection recreation

For large transaction sheets, that creates unusable edit latency.

## Maintenance Rule

When changing the Sheets client:
- preserve the transaction-local update model for edit/save operations
- treat any return to full-sheet rewrites in hot paths as a regression
