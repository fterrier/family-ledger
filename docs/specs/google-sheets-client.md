# Google Sheets Client

## Purpose

The Google Sheets client is a constrained API client for common ledger workflows, especially transaction review, recategorization, splitting, quick manual entry, and importer operations.

The spreadsheet is not the source of truth. All writes go through the API.

## Menu Surface

The current `Family Ledger` menu exposes:

- `Quick Filter`
- `Add Transaction`
- `Add Balance Assertion`
- `Add Account`
- `Add Commodity`
- `Add Attachment`
- `Sheet Settings`
- `Importer Settings`
- `Import data`
- `Developer Settings` submenu with `Sync Ledger`, `Reset Sheet Layouts`, `API Settings`, and `Test Connection`

## Managed Sheets

`Sync Ledger` manages these sheets:

- `Accounts`
- `Transactions`
- `Balances`
- `Commodities`
- `Attachments`
- `Issues`

The sync path pulls canonical API data, rewrites the managed sheets, and refreshes derived doctor issues.

## Supported Transaction Model

The editable `Transactions` sheet is intentionally narrower than the full API transaction model.

Current supported workflow centers on one source posting plus zero or more destination postings:

- normal spending
- income
- balance-sheet transfers
- source-only transactions
- multi-destination splits

Rows that would require an ambiguous or misleading editing model are skipped during sync rather than rendered unsafely.

Current notable limits:

- one symbol across the rendered transaction
- no cost or price editing in Sheets
- the synced allocation sheet currently focuses on a constrained rendered transaction model

## Transactions Sheet Model

The transactions sheet is allocation-based.

- one transaction may occupy multiple rows
- rows are grouped by hidden `resource_name`
- row order becomes posting order on save
- the first visible column is an `edit` action column that opens the edit/delete sidebar

The visible editing flow operates on:

- `payee`
- `narration`
- `destination_account_name`
- `amount`
- `split_off_amount`

Read-only technical fields such as `resource_name`, `narration_source`, and `last_error` stay hidden.

## Save And Issue Model

The client auto-saves supported edits at transaction scope.

- save reconstructs a full transaction payload and sends `PATCH /transactions/{transaction}`
- successful saves refresh the rendered rows when needed
- doctor issues are refreshed after sync and after each successful save
- doctor-derived issues appear in the visible `issues` column and trigger row highlighting
- transient save errors use `status=error` and hidden `last_error` without doctor highlighting

A manual retry is available by opening the edit sidebar and saving again from there.

## Quick Filter

`Quick Filter` applies native Google Sheets filter criteria without changing ledger data.

Current scope:

- date filters apply to `Transactions` and `Balances`
- account filters apply to `Transactions`, `Balances`, and `Accounts`
- filter state is persisted in document properties

## Entity CRUD Sidebars

All managed entity types support create, edit, and delete through a shared sidebar system. The `edit` checkbox column in each sheet opens the edit sidebar for that row. The `Family Ledger` menu provides `Add ...` items for each entity type.

Supported via the sidebar for all entity types:

- **Accounts**: create with `account_name`, `effective_start_date`, `effective_end_date`; edit any of those fields
- **Balance Assertions**: create and edit `assertion_date`, `account`, `amount`, `symbol`
- **Commodities**: create with `symbol`
- **Attachments**: create with `account`, `attachment_date`, `original_filename`, `document_url`
- **Transactions**: create and edit (see Transactions Sheet Model below)

Entity creates inject `entity_metadata: { source: "google_sheets_quick_add" }` into the API payload for provenance tracking.

## Add Transaction

`Add Transaction` is the fast path for new manual transactions.

- simple mode targets common two-posting entry
- advanced mode allows explicit posting lists
- the same sidebar is reused for editing and deleting supported existing transactions

This exists because the main sheet is optimized for reviewing synced allocation rows, not for being a generic transaction-composer UI.

## Sheet Settings

`Sheet Settings` stores spreadsheet-local preferences in document properties.

Current settings focus on quick-add behavior:

- shortlisted source accounts
- shortlisted destination accounts
- shortlisted symbols
- default source account
- default symbol

These settings intentionally belong to the spreadsheet, not the server, because they tune one client workflow rather than canonical ledger state.

## Importer Settings And Import Data

The Sheets client exposes both importer flows:

- `Importer Settings`: edit persistent importer config on the server via `PATCH /importers/{importer}`
- `Import data`: upload a file and run an importer synchronously, optionally with one-off override values for that run

These two flows share a single mode-driven dialog implementation.

## Why The Client Is Constrained

The client deliberately optimizes for the high-value everyday workflow instead of pretending that every ledger shape is safely editable in one flat grid.

- canonical truth remains in the API and database
- shapes that do not fit the current synced allocation model may still be omitted from the main editable sheet until they have a dedicated safe editing path
- hot paths favor local row updates over whole-sheet rewrites
- spreadsheet-local settings remain local; importer settings remain server-side
