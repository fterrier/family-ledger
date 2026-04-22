# Google Sheets Client

This client lets you edit supported `family-ledger` transactions from Google Sheets.

It is intended for the common workflow of reviewing and adjusting bank or card outgoings:
- recategorize a normal outgoing
- split one outgoing into multiple destination rows
- save changes back to the API automatically

The spreadsheet is a client of the API. It is not the source of truth.

## What It Can Edit

The current Sheets workflow supports transactions that look like:
- one source posting
- one or more destination postings
- one symbol across the transaction
- no cost or price data

In practice, this fits:
- bank/card spending
- transfers to another account
- split categorization of one outgoing

Unsupported transaction shapes are skipped during sync and reported back in the sync summary.

## Requirements

You need:
- a running `family-ledger` API
- a public HTTPS URL reachable from Google Apps Script
- an API token configured in `family-ledger`
- a Google Sheet

Recommended remote access setup:
- run `family-ledger` on-prem
- expose it through `Tailscale Funnel`
- use the same bearer token in both the server config and Sheets client

## Files

- `Code.js`: Apps Script source
- `appsscript.json`: Apps Script manifest
- `package.json`: local validation tooling
- `eslint.config.js`: local lint configuration

## Installation

1. Create a Google Sheet.
2. Open `Extensions -> Apps Script`.
3. Replace the default script contents with `Code.js` from this directory.
4. In the Apps Script editor, enable `Show "appsscript.json" manifest file in editor` in `Project Settings`.
5. Replace the manifest contents with `appsscript.json` from this directory.
6. Save the Apps Script project.
7. Return to the spreadsheet and reload the page.

If the permission prompt does not appear automatically:

1. In the Apps Script editor, select `onOpen`.
2. Click `Run`.
3. Accept the permission prompt.
4. Return to the spreadsheet and reload it.

## First-Time Setup

After the `Family Ledger` menu appears:

1. Run `Set API Base URL` and paste your public API URL.
2. Run `Set API Token` and paste your bearer token.
3. Run `Test Connection`.
4. Run `Sync Accounts`.
5. Run `Sync Transactions`.

Expected result:
- the script creates the local `Accounts` and `Transactions` sheets if needed
- `Test Connection` confirms both reachability and authenticated access
- the transaction sheet is populated with editable allocation rows

The first sync also installs the authorized edit trigger used for auto-save.

The technical `transaction_name` column is kept in the sheet but hidden from normal use.

## Daily Use

Normal flow:
1. Open the `Transactions` sheet.
2. Edit `payee`, `narration`, or `destination_account_name` directly.
3. For imported transactions, treat `amount` as an allocation amount inside a fixed total.
3. Watch `status` and `last_error`.

For splits:
1. Either reduce the row `amount`, or enter a positive value in `split_off_amount`.
2. The script inserts a sibling row automatically.
3. The new row starts with the same destination account as the original row.
4. Change the new row's `destination_account_name` if needed.

To delete a split row:
1. Enter `x` or `-` in `split_off_amount`.
2. The row is merged back into a sibling allocation row.

Manual fallback:
- `Push Active Transaction` is available if automatic save fails and you want to retry explicitly.

## Status Values

- `dirty`: local changes are pending
- `saving`: the transaction is being patched to the API
- `saved`: the transaction was saved successfully
- `error`: the save failed; see `last_error`

Imported transaction totals are fixed:
- reducing an `amount` creates a split for the difference
- increasing an `amount` is rejected and the old value is restored

## Tailscale Funnel Setup

Google Apps Script cannot call `localhost` or a private-only network address.

Suggested setup:

1. Start `family-ledger` locally.
2. Ensure `FAMILY_LEDGER_API_TOKEN` is configured.
3. Expose the API with Funnel:

```bash
tailscale funnel --bg --yes 8000
```

4. Verify reachability:

```bash
curl https://<your-funnel-url>/healthz
```

5. Verify authenticated access:

```bash
curl -H "Authorization: Bearer <your-token>" \
  "https://<your-funnel-url>/accounts?page_size=1"
```

## Permissions

The current manifest asks for:
- access to the current spreadsheet only
- outbound HTTP requests
- script trigger management for the installable edit trigger used by auto-save

See `docs/permissions.md` for the detailed rationale.

## Troubleshooting

If the menu does not appear:
- save the Apps Script project
- run `onOpen` once manually from the Apps Script editor
- reload the spreadsheet

If sync succeeds but rows are missing:
- those transactions are likely unsupported by the current Sheets workflow
- check the sync summary dialog for skipped examples

If a save fails:
- look at `status`
- look at `last_error`
- use `Push Active Transaction` as a fallback retry

If an `amount` edit is rejected:
- imported transaction totals are fixed
- reduce an amount to split it
- direct increases are not allowed

## Limits

This client does not currently support:
- arbitrary multi-leg ledger editing
- FX/cost/price-heavy transactions
- server-side creation of accounts, commodities, prices, assertions, or transactions
- spreadsheet-as-source-of-truth workflows

## More Documentation

- Design: `docs/design.md`
- Permissions: `docs/permissions.md`
- Performance: `docs/performance.md`
