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

Every transaction is displayed in the Transactions sheet. The rendering uses a **weight-based model** so that investment, FX, and income transactions appear naturally alongside simple expenses.

### Weight computation

Each posting's _weight_ is its value in the settlement currency:

| Posting has | Weight |
|---|---|
| `cost` | `units.amount × cost.amount` in `cost.symbol` |
| `price` (no cost) | `units.amount × price.amount` in `price.symbol` |
| neither | `units` (amount and symbol unchanged) |

Zero-weight postings are suppressed and never appear in the sheet.

### Grouping

Postings are partitioned by `weight.symbol`. Each non-empty partition is a **group**, processed independently to produce one or more sheet rows.

### Source selection (within each group)

The first posting in the group is the source. All remaining postings are destinations.

Source selection is controlled by posting order in the ledger file. The ledger owner is responsible for placing the intended source posting first within each weight-symbol group.

### Amount column sum meaning

| Filtered by | Sum means |
|---|---|
| Expense account | Net spending in that category |
| Income account | Net income received (bank-side flow) |
| Asset/liability account | Gross transaction volume (not net position) |

Net account balances live in the Balances sheet.

### Cost/price transactions

If any posting in a transaction has a non-null `cost` or `price`, the entire transaction is flagged `hasCostPrice`. The Amount and symbol columns reflect the _weight_ (settlement value), not the raw units. Inline edits to `destination_account_name`, `amount`, and `split_off_amount` are blocked with a toast error — the sidebar postings editor is the only edit path. `payee` and `narration` remain editable inline.

### Examples

| Transaction | Groups | Source | Destination | Amount | Symbol |
|---|---|---|---|---|---|
| Grocery expense | 1 (CHF) | Bank [A] | Food [X] | 84.25 | CHF |
| Salary | 1 (CHF) | Salary [I] | Bank [A] | 5000 | CHF |
| Account transfer | 1 (CHF) | Checking [A] | Savings [A] | 100 | CHF |
| Expense refund | 1 (CHF) | Bank [A] | Food [X] | −20 | CHF |
| Investment buy (VTI @ 200 CHF) | 1 (CHF) | Bank [A] | Investments [A] | 1000 | CHF |
| FX conversion | 2 (CHF, USD) | Bank CHF [A] / Bank USD [A] | — / — | 900 / −1000 | CHF / USD |
| Split payment | 1 (CHF) | Bank [A] | Food [X], Household [X] | 50, 34.25 | CHF |

Current notable limits:

- the edit sidebar does not yet support creating transactions with cost or price directly (postings editor allows editing existing cost/price values)

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
