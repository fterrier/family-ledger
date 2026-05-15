# Google Sheets Client

This client exposes a constrained `family-ledger` workflow inside Google Sheets.

It is designed for common day-to-day operations:

- sync ledger data into managed sheets
- review and recategorize supported transactions
- split supported transactions across multiple destinations
- add simple manual transactions quickly
- edit persistent importer settings and run imports

The spreadsheet is a client of the API. It is not the source of truth.

## Requirements

You need:

- a running `family-ledger` API
- a public HTTPS URL reachable from Google Apps Script
- an API token configured in `family-ledger`
- a Google Sheet

Recommended remote access setup:

- run `family-ledger` on-prem
- expose it with Tailscale Funnel
- use the same bearer token in both the server config and Sheets client

## Current Menu Surface

`Family Ledger` currently exposes:

- `Quick Filter`
- `Quick Add Transaction`
- `Sheet Settings`
- `Importer Settings`
- `Import data`
- `Developer Settings` submenu with `Sync Ledger`, `Push Active Transaction`, `Reset Sheet Layouts`, `API Settings`, and `Test Connection`

`Sync Ledger` manages these sheets:

- `Accounts`
- `Transactions`
- `Balances`
- `Commodities`
- `Issues`

## Deploying With `clasp`

`clasp` is the preferred way to push changes.

### One-time setup

1. Enable the Google Apps Script API for your account.
2. Install dependencies:

```bash
npm install
```

3. Log in:

```bash
npm run clasp:login
```

4. Create `.clasp.json` with your Apps Script project ID.

Example:

```json
{"scriptId": "<your-script-id>", "rootDir": "."}
```

### Push changes

```bash
npm run push
```

Reload the spreadsheet after pushing to pick up menu changes.

## Manual Installation

If `clasp` is not available:

1. Create a Google Sheet.
2. Open `Extensions -> Apps Script`.
3. Create one Apps Script file for each runtime `.js` file in this directory.
4. Create one HTML file for each runtime `.html` file in this directory.
5. Enable the manifest file in Apps Script project settings and paste in `appsscript.json`.
6. Save the script project and reload the spreadsheet.

If the permission prompt does not appear automatically, run `onOpen` once from the Apps Script editor.

## First-Time Setup

After the `Family Ledger` menu appears:

1. Open `Developer Settings -> API Settings` and set the base URL and API token.
2. Run `Developer Settings -> Test Connection`.
3. Run `Developer Settings -> Sync Ledger`.

Expected result:

- reachability and authenticated access are confirmed
- the managed sheets are created if needed
- the first sync installs the authorized edit trigger used for auto-save

## Main Workflows

### Daily editing

- edit supported rows directly in `Transactions`
- watch `status` and `issues`
- use `Push Active Transaction` if you need a manual retry path

### Quick add

`Quick Add Transaction` is the fast path for new manual entries.

- simple mode covers common two-posting transactions
- advanced mode allows explicit posting lists
- `Sheet Settings` stores spreadsheet-local quick-add shortlists and defaults

### Importers

- `Importer Settings` edits persistent importer config on the server
- `Import data` uploads a file and runs the selected importer synchronously

## Local Tooling

- `npm run check`
- `npm test`

## More Documentation

- Canonical Sheets feature spec: `../../docs/specs/google-sheets-client.md`
- Sheets maintenance guide: `../../docs/guides/google-sheets-client.md`
- Permissions rationale: `docs/permissions.md`
- Performance notes: `docs/performance.md`

## Troubleshooting

If the menu does not appear:

- save the Apps Script project
- run `onOpen` once manually
- reload the spreadsheet

If connection testing fails:

- verify the public HTTPS URL
- verify the bearer token
- verify that `GET /healthz` is reachable from Apps Script

If sync succeeds but transactions are missing:

- those transactions are likely outside the current supported Sheets editing model
- check the sync summary and `Issues` sheet

If a save fails:

- inspect `status`
- inspect the hidden `last_error` column if needed
- retry with `Push Active Transaction`
