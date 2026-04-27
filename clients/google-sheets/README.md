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
- zero or more destination postings
- one symbol across the transaction
- no cost or price data

In practice, this fits:
- bank/card spending
- source-only imported transactions awaiting categorization
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
- `ImportDialog.html`: HTML modal for the Import data dialog
- `appsscript.json`: Apps Script manifest
- `package.json`: local tooling (lint, tests, clasp)
- `eslint.config.js`: lint configuration
- `.clasp.json`: clasp project config — not committed, contains the script ID

## Deploying with clasp

`clasp` is the preferred way to push changes. It is already configured in `package.json`.

### One-time setup

1. **Enable the Apps Script API** for your Google account:
   `https://script.google.com/home/usersettings` → turn on "Google Apps Script API".

2. **Install dependencies** (includes `@google/clasp`):
   ```bash
   npm install
   ```

3. **Log in**:
   ```bash
   npm run clasp:login
   ```
   This opens a browser for OAuth and writes credentials to `~/.clasprc.json`. Only needed once per machine.

4. **Create `.clasp.json`** with your Apps Script project's script ID. Find it in the Apps Script editor under `Project Settings → Script ID`:
   ```bash
   SCRIPT_ID=<your-script-id> npx clasp create --type sheets --title "family-ledger" 2>/dev/null || \
     echo "{\"scriptId\":\"$SCRIPT_ID\",\"rootDir\":\".\"}" > .clasp.json
   ```
   Or just create `.clasp.json` manually:
   ```json
   {"scriptId": "<your-script-id>", "rootDir": "."}
   ```

### Pushing changes

```bash
npm run push
```

This uploads `Code.js`, `ImportDialog.html`, and `appsscript.json` to the Apps Script project. Reload the spreadsheet after pushing to pick up menu changes.

### What is excluded

`.claspignore` prevents `node_modules/`, `tests/`, `docs/`, and config files from being uploaded. Only the three runtime files are pushed.

## Manual Installation (alternative)

If clasp is not available:

1. Create a Google Sheet.
2. Open `Extensions -> Apps Script`.
3. Replace the default script contents with `Code.js` from this directory.
4. In the Apps Script editor, enable `Show "appsscript.json" manifest file in editor` in `Project Settings`.
5. Replace the manifest contents with `appsscript.json` from this directory.
6. Create an HTML file named `ImportDialog` and paste in `ImportDialog.html`.
7. Save the Apps Script project.
8. Return to the spreadsheet and reload the page.

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

Account names are shortened for readability in the sheet, for example:
- `[A] Bank - Checking - Family`
- `[L] CreditCard - Visa`
- `[X] Food - Groceries`

The marker indicates the account root:
- `[A]` Assets
- `[L]` Liabilities
- `[X]` Expenses
- `[I]` Income
- `[Q]` Equity

## Daily Use

Normal flow:
1. Open the `Transactions` sheet.
2. Edit `payee`, `narration`, or `destination_account_name` directly.
3. For imported transactions, treat `amount` as an allocation amount inside a fixed total.
4. Watch `status` and `issues` during normal use.

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

Read-only columns are shaded differently from editable columns.
The `split_off_amount` column is highlighted as an action field and its header note explains the supported commands.

## Status Values

- `dirty`: local changes are pending
- `saving`: the transaction is being patched to the API
- `saved`: the transaction was saved successfully
- `error`: the save failed; see `last_error`

Derived `ledger:doctor` issues are shown in the `issues` column.
Rows with doctor issues are highlighted in light red.
Transient save failures still use `status=error` and `last_error` without applying the red issue highlight.
`last_error` is kept as a hidden technical column next to `status`.
The sheet refreshes doctor issues separately after sync and after each successful save.

Imported transaction totals are fixed:
- reducing an `amount` creates a split for the difference
- increasing an `amount` is rejected and the old value is restored
- invalid `split_off_amount` commands are cleared immediately

Source-only transactions behave differently:
- they render as one row with a blank destination account
- setting `destination_account_name` creates the destination posting on save
- deleting the last destination row with `x` or `-` returns the transaction to source-only state
- direct `amount` edits are not allowed while the transaction is source-only
- the split helper is not available while the transaction is source-only

## Importing Data

`Family Ledger → Import data` opens a modal dialog that lets you load ledger data from
external files directly into the API.

### Workflow

1. **Select an importer** from the dropdown. Available importers depend on what is
   installed on the server.
2. **Review configuration**. If the importer has required configuration (for example, a
   target account), fields are shown. Fields already saved on the server are read-only;
   empty fields can be filled in for this import run only.
3. **Choose a file** using the file picker.
4. Click **Import**. The file is uploaded to the API and the import runs synchronously.
5. The result table shows per-entity counts:
   - **Created**: new entities added to the database
   - **Duplicate**: entities already present, skipped without error
   - **Errors**: entries that could not be imported, with example messages
   Warnings (non-fatal notices from the importer) are listed below the table.
6. Click **Import another file** to run a follow-up import with the same settings.

### Beancount importer

The server ships with the **Beancount** importer. It loads accounts, commodities,
transactions, prices, and balance assertions from a `.beancount` file.

The Beancount importer requires an **empty database**. It is a one-time bootstrap tool
for migrating an existing Beancount ledger into family-ledger. Running it on a populated
database returns an error. No configuration is required.

### Persistent configuration

Some importers have persistent configuration stored on the server (visible as read-only
fields in the dialog). To update persistent config, use `PATCH /importers/{importer}`
directly on the API. Editing persistent config from within the dialog is not yet
supported.

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
- inspect the hidden `last_error` column if needed
- use `Push Active Transaction` as a fallback retry

If an `amount` edit is rejected:
- imported transaction totals are fixed
- reduce an amount to split it
- direct increases are not allowed

If a `split_off_amount` command is rejected:
- the helper cell is cleared immediately
- allowed commands are a positive number, `x`, or `-`

## Limits

This client does not currently support:
- arbitrary multi-leg ledger editing
- FX/cost/price-heavy transactions
- manual creation of accounts, commodities, prices, or balance assertions from the sheet
- spreadsheet-as-source-of-truth workflows

## More Documentation

- Design: `docs/design.md`
- Permissions: `docs/permissions.md`
- Performance: `docs/performance.md`
