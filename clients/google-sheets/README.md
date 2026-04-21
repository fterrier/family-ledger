# Google Sheets POC

This is a narrow Google Sheets client for `family-ledger`.

It is intentionally limited to the first spreadsheet workflow we want to validate:
- load accounts into a helper sheet
- load simple two-posting transactions into an editable sheet
- recategorize a transaction by changing one account
- split the category side of a transaction into multiple postings
- submit the edited transaction back through `PATCH /transactions/{transaction}`

The spreadsheet is a client of the API. It is not the source of truth.

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

## Usage

After reloading the spreadsheet, use the `Family Ledger` menu:

1. `Set API Base URL`
2. `Sync Accounts`
3. `Sync Transactions`
4. Edit one row in `Transactions`
5. `Push Active Row`

You can either:
- change `category_account_name`
- or provide `split_postings_json`

If `split_postings_json` is present, it takes precedence over the single category field.

## What This POC Does Not Try To Solve

- full transaction editing for arbitrary posting shapes
- row-level live sync or conflict detection
- batch editing workflows
- full account autocomplete UX beyond a basic dropdown
- spreadsheet-based source-of-truth behavior

## Next Likely Steps

- add transaction filtering instead of syncing all simple transactions
- support pushing multiple marked rows
- support a more explicit split-editing tab instead of JSON-in-a-cell
- add auth once the API has auth
