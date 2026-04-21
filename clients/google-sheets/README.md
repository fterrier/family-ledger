# Google Sheets Client

This Google Sheets client is a focused editor for existing `family-ledger` transactions.

It is designed for the main workflow we care about first:
- bank or card outgoings
- transfers out of a bank or card account
- recategorizing a normal two-posting transaction
- splitting one outgoing into multiple destination allocations
- pushing the updated transaction back through `PATCH /transactions/{transaction}`

The spreadsheet is a client of the API. It is not the source of truth.

Current server-side write scope from this client:
- `PATCH /transactions/{transaction}` only

## Scope

The sheet supports a specific transaction family:
- exactly one source posting
- one or more destination postings
- a single symbol across the transaction
- no cost or price data

This fits the intended Sheets use cases well:
- bank/card spending
- transfers to another account
- splitting a single outgoing across multiple categories

Unsupported transactions are skipped during sync and reported back to the user with examples.

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
npm test
```

This tooling is intentionally local to this client folder so the Sheets client can move to its own repo later without dragging root-level JavaScript setup with it.

## Sheet Layout

The script manages two sheets:

### `Accounts`

Columns:
- `account_name`
- `name`

This sheet is used for account lookup and dropdown validation.

### `Transactions`

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

## Single-Sheet Transaction Model

The `Transactions` sheet is allocation-based.

- a normal two-posting outgoing appears as one row
- a split transaction appears as multiple rows with the same `transaction_name`
- each row represents one final destination allocation

Example:

- source posting: `Assets:Bank:Checking -84.25 CHF`
- destination postings:
  - `Expenses:Food 50.00 CHF`
  - `Expenses:Household 34.25 CHF`

That transaction appears as two rows in the sheet, both with the same `transaction_name`, `transaction_date`, `payee`, `narration`, `source_account_name`, and `symbol`, but different `destination_account_name` and `amount` values.

## Grouping And Ordering

- transaction rows are identified by `transaction_name`
- contiguous grouping is preferred for readability, but not required
- the client gathers all rows for the same `transaction_name` when pushing
- current sheet row order becomes destination posting order on push
- sync preserves server order by default

If rows for a transaction become scattered, use `Regroup Active Transaction`.

## Setup

1. Create a Google Sheet.
2. Open `Extensions -> Apps Script`.
3. Replace the default `Code.gs` contents with the contents of `Code.js` from this repo.
4. In the Apps Script editor, open `Project Settings` and enable `Show "appsscript.json" manifest file in editor`.
5. Open `appsscript.json` in the editor and replace its contents with the contents of `appsscript.json` from this repo.
6. Save the Apps Script project.
7. Return to the spreadsheet and reload the page so the `Family Ledger` menu appears.

If the authorization popup does not appear automatically:

1. In the Apps Script editor, select the `onOpen` function.
2. Click `Run`.
3. Accept the permission prompt.
4. Return to the spreadsheet and reload it.

On the first run, Google will ask you to authorize the script because it uses:
- access to the current spreadsheet only
- outbound HTTP requests via `UrlFetchApp`

## Tailscale Funnel Setup

If your API is only running on your laptop, `http://localhost:8000` will not work from Google Sheets itself.
Use a URL reachable from Google infrastructure.

For this project, the recommended setup is `Tailscale Funnel` plus a bearer token configured through `FAMILY_LEDGER_API_TOKEN` on the server.

Prerequisites:
- Tailscale installed on the machine running the API
- Tailscale HTTPS enabled for your tailnet
- Tailscale Funnel enabled for your tailnet and device
- `family-ledger` running locally and listening on port `8000`

Suggested flow:

1. Set a strong `FAMILY_LEDGER_API_TOKEN` in your deployment environment.
2. Start `family-ledger` locally.
3. On the host running the API, expose it with Funnel:

```bash
tailscale funnel --bg --yes 8000
```

4. Verify public reachability:

```bash
curl https://<your-funnel-url>/healthz
```

Expected response:

```json
{"status":"ok"}
```

5. Verify authenticated API access:

```bash
curl -H "Authorization: Bearer <your-token>" \
  "https://<your-funnel-url>/accounts?page_size=1"
```

Notes:
- `tailscale serve 8000` is not enough for Google Sheets because it is tailnet-private, not public
- `tailscale funnel 8000` makes the API publicly reachable over HTTPS, so the bearer token is mandatory
- public DNS propagation for a new Funnel URL can take a few minutes

## First-Time Google Sheets Setup

Use this flow in a blank Google Sheet:

1. Open the sheet.
2. Open `Extensions -> Apps Script`.
3. Replace the default script with `Code.js` from this repo.
4. Replace the manifest with `appsscript.json` from this repo.
5. Save the Apps Script project.
6. Reload the spreadsheet.
7. Open the `Family Ledger` menu.
8. Run `Set API Base URL` and paste your Funnel URL.
9. Run `Set API Token` and paste your server token.
10. Run `Test Connection`.
11. Run `Sync Accounts`.
12. Run `Sync Transactions`.

The first sync also installs the authorized edit trigger used for auto-save.

Expected result:
- the script creates the local `Accounts` and `Transactions` tabs if they do not exist yet
- `Test Connection` shows both health and authenticated ledger access
- the transaction sheet is populated with supported transactions in allocation-row form

## Usage

After reloading the spreadsheet, use the `Family Ledger` menu:

1. `Set API Base URL`
2. `Set API Token`
3. `Show Current Settings`
4. `Test Connection`
5. `Sync Accounts`
6. `Sync Transactions`
7. Edit rows in `Transactions`
8. Edit rows directly in `Transactions`
9. Use `Push Active Transaction` only as a fallback if auto-save fails

## Editing Rules

- `payee` and `narration` are transaction-level fields
- editing either field on one row propagates to all rows for the same `transaction_name`
- `destination_account_name` and `amount` are row-specific and do not propagate
- entering a value in `split_off_amount` splits the current allocation row automatically
- supported edits auto-save the full transaction automatically
- the client gathers all rows with the same `transaction_name` when saving
- current sheet row order for that transaction becomes destination posting order

## Split Workflow

Use the `split_off_amount` column to split one allocation row into two.

Flow:
1. Enter a positive amount in `split_off_amount` on the row you want to split.
2. The script inserts a new row below the current row.
3. The new row receives the split amount.
4. The original row amount is reduced by the split amount.
5. The new row initially uses the same `destination_account_name` as the original row.
6. Edit the new row's `destination_account_name` if needed.
7. The transaction auto-saves after each edit.

Rules:
- split amount must be greater than zero
- split amount must be less than the selected row amount
- the final row amounts for the transaction must still sum to the full source amount

## Auto-Save

The client auto-saves supported edits at the transaction level.

Edits that trigger auto-save:
- `payee`
- `narration`
- `destination_account_name`
- `amount`
- `split_off_amount`

Status values:
- `dirty`: local sheet edits are pending
- `saving`: the transaction is being patched to the API
- `saved`: the transaction was pushed successfully
- `error`: the push failed; see `last_error`

`Push Active Transaction` remains available as a fallback action, but it is no longer the normal workflow.

## Sync Feedback

During `Sync Transactions`, the client shows a summary dialog with:
- total transactions fetched from the server
- total allocation rows written to the sheet
- how many unsupported transactions were skipped
- up to 10 skipped transaction examples

## Performance Notes

This client is expected to handle large transaction sheets, including sheets with many thousands of rows.

Performance rules for the current implementation:
- `Sync Transactions` may rebuild the full `Transactions` sheet
- active-row actions should operate only on the active transaction, not the full sheet
- edit-driven actions should operate only on the edited transaction, not the full sheet
- auto-save should only read and write rows for the edited `transaction_name`
- `payee` and `narration` propagation should update only rows for the edited transaction, not rewrite the full sheet

For large sheets:
- prefer using transaction-specific actions over manual bulk cleanup
- regroup scattered transaction rows only when needed
- avoid unnecessary full-sheet sorts while editing

## Error Reporting

Menu actions show alert dialogs on failure, including:
- missing base URL or token
- API reachability or auth failures
- validation failures before push
- unknown accounts in edited rows
- invalid or inconsistent split/group data

The sheet also writes row-level `status` and `last_error` values when relevant.

## What This Client Does Not Try To Solve Yet

- arbitrary ledger transaction editing for all posting shapes
- FX/cost/price-heavy transaction editing
- row-level live sync with conflict resolution
- server-side creation of accounts, commodities, prices, assertions, or transactions from Sheets in this version
