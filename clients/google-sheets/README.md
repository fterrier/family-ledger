# Google Sheets POC

This is a narrow Google Sheets client for `family-ledger`.

It is intentionally limited to the first spreadsheet workflow we want to validate:
- load accounts into a helper sheet
- load simple two-posting transactions into an editable sheet
- recategorize a transaction by changing one account
- split the category side of a transaction into multiple postings
- submit the edited transaction back through `PATCH /transactions/{transaction}`

The spreadsheet is a client of the API. It is not the source of truth.

Current server-side write scope from this client:
- `PATCH /transactions/{transaction}` only

## Current Scope

The POC only syncs transactions that currently have exactly two postings.

For those transactions, it treats:
- `postings[0]` as the preserved source posting
- `postings[1]` as the editable category posting

That is narrow on purpose. It matches the first category-editing workflow without trying to solve full spreadsheet ledger editing.

## Files

- `Code.js`: Google Apps Script source
- `appsscript.json`: Apps Script manifest
- `package.json`: local Node tooling for validation
- `eslint.config.js`: local Apps Script lint configuration

## Local Validation Tooling

Node is optional for using the sheet manually, but recommended for local checks and CI.

Run from `clients/google-sheets/`:

```bash
npm install
npm run check
```

This tooling is intentionally local to this client folder so the Sheets client can move to its own repo later without dragging root-level JavaScript setup with it.

## Sheet Layout

The script manages two sheets:

### `Accounts`

Columns:
- `account_name`
- `name`

This sheet is used for category lookup and dropdown validation.

### `Transactions`

Columns:
- `transaction_name`
- `transaction_date`
- `payee`
- `narration`
- `source_account_name`
- `category_account_name`
- `amount`
- `symbol`
- `split_postings_json`
- `status`
- `last_error`
- `original_transaction_json`

Notes:
- `category_account_name` is editable.
- `split_postings_json` is optional and editable.
- `original_transaction_json` is maintained by the script and hidden automatically.

## Split Format

Leave `split_postings_json` blank for a simple recategorization.

For a split, use JSON with one object per replacement category posting:

```json
[
  {
    "account_name": "Expenses:Food",
    "amount": "50.00"
  },
  {
    "account_name": "Expenses:Household",
    "amount": "34.25"
  }
]
```

Rules:
- each split amount is expressed in the existing transaction symbol
- split amounts must sum exactly to the existing category posting amount
- the source posting is preserved as-is

## Setup

1. Create a Google Sheet.
2. Open `Extensions -> Apps Script`.
3. Paste `Code.js` into the script project.
4. Replace the default manifest with `appsscript.json`.
5. In Apps Script, open `Project Settings -> Script properties`.
6. Add `FAMILY_LEDGER_BASE_URL` with your API base URL, for example:

```text
http://localhost:8000
```

If you access the API through a tunnel or reverse proxy, use that URL instead.

On the first run, Google will ask you to authorize the script because it uses:
- spreadsheet access
- outbound HTTP requests via `UrlFetchApp`

If your API is only running on your laptop, `http://localhost:8000` will not work from Google Sheets itself.
Use a URL reachable from Google infrastructure, such as:
- `Tailscale Funnel` on your on-prem server
- another public reverse proxy or tunnel
- a deployed environment

For this project's supported setup, use `Tailscale Funnel` plus a bearer token configured through `FAMILY_LEDGER_API_TOKEN` on the server.

## Usage

After reloading the spreadsheet, use the `Family Ledger` menu:

1. `Set API Base URL`
2. `Set API Token`
3. `Test Connection`
4. `Sync Accounts`
5. `Sync Transactions`
6. Edit one row in `Transactions`
7. `Push Active Row`

`Sync Accounts` and `Sync Transactions` will create the local tabs if they do not exist yet.

You can either:
- change `category_account_name`
- or provide `split_postings_json`

If `split_postings_json` is present, it takes precedence over the single category field.

## Manual Test Flow

Use this checklist to validate the current version before changing the UX:

1. Start the API and ensure it is reachable from Google Sheets.
2. Load some test data into the ledger.
3. Open the spreadsheet and run `Family Ledger -> Sync Accounts`.
4. Run `Family Ledger -> Sync Transactions`.
5. Confirm that only simple two-posting transactions appear.
6. Pick one row and change only `category_account_name`.
7. Run `Family Ledger -> Push Active Row`.
8. Confirm `status` becomes `pushed` and `last_error` stays blank.
9. Re-run `Sync Transactions` and confirm the category change persisted.
10. Pick another row and fill `split_postings_json` with a valid split.
11. Run `Push Active Row` again.
12. Re-run `Sync Transactions` and confirm the transaction no longer appears if it is no longer a simple two-posting transaction.

Expected current behavior after a split:
- the patch should succeed
- the transaction is updated in the API
- the split transaction will usually disappear from the sheet on the next sync because this POC only lists two-posting transactions

That disappearance is expected in the current design.

## What This POC Does Not Try To Solve

- full transaction editing for arbitrary posting shapes
- row-level live sync or conflict detection
- batch editing workflows
- full account autocomplete UX beyond a basic dropdown
- spreadsheet-based source-of-truth behavior
- server-side creation of accounts, commodities, prices, assertions, or transactions from Sheets in this version

## Next Likely Steps

- add transaction filtering instead of syncing all simple transactions
- support pushing multiple marked rows
- support a more explicit split-editing tab instead of JSON-in-a-cell
- add auth once the API has auth

## Next UX Improvements

These are the most useful UX improvements to make after this trial if the current interaction feels too rough:

- protect non-editable columns such as `transaction_name`, `source_account_name`, `amount`, `symbol`, and `original_transaction_json`
- add a `dirty` status when editable cells change so it is obvious which rows still need pushing
- add a `last_synced_at` or `last_pushed_at` timestamp column for better operator feedback
- add a dedicated `eligible_for_sync` or `notes` column so skipped transactions are easier to explain
- show a clearer success message after push, not just `pushed`
- preserve a pushed split row locally instead of having it silently disappear on the next sync
- replace JSON-in-a-cell splits with a dedicated split editor tab if manual split entry proves too awkward
- add row filtering or date-range filtering before sync so the transaction sheet stays small and reviewable
- support pushing multiple selected rows or rows marked for update
- add a refresh of the single pushed row after a successful patch so the sheet reflects the server's canonical response immediately
