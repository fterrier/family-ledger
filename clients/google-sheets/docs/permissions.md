# Google Sheets Client Permissions

## Current Manifest Scopes

The current Apps Script manifest declares:
- `https://www.googleapis.com/auth/spreadsheets.currentonly`
- `https://www.googleapis.com/auth/script.external_request`
- `https://www.googleapis.com/auth/script.scriptapp`

## Why Each Scope Exists

### Current Spreadsheet Only

`spreadsheets.currentonly` lets the script:
- create and update the local `Accounts` and `Transactions` sheets
- write values, validation, and status cells in the bound spreadsheet

It is intentionally narrower than broad access to all spreadsheets.

### External Requests

`script.external_request` lets the client call the `family-ledger` API using `UrlFetchApp`.

This is required for:
- connection tests
- account sync
- transaction sync
- transaction `PATCH` saves

### Script Trigger Management

`script.scriptapp` is required because the client installs and checks an authorized edit trigger for auto-save.

The client uses `ScriptApp` to:
- inspect existing project triggers
- install the edit trigger used by `handleTransactionEdit`

Without this scope, the trigger-management path fails.

## Documentation Rule

The permissions explanation in user-facing docs should stay short and practical.

Detailed permission rationale belongs here, close to the client implementation.

If the client changes and no longer uses a scope, update this file and the manifest together.
