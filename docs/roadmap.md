# Roadmap

This document tracks planned work, verified implementation state, and deferred scope. It supersedes the archived `archive/docs/roadmap-v0.1.md`.

## Implementation State

### Implemented

- canonical storage for accounts, commodities, transactions, postings, prices, balance assertions, attachments, importer config
- authenticated FastAPI routes for all canonical entity types
- `POST /ledger:doctor` — derived diagnostics: unbalanced transactions, FIFO lot failures, balance assertion failures, attachment issues
- `GET /accounts/{account}:pad` — on-demand pad computation
- `POST /transactions:normalize` — validation without persistence
- Beancount export CLI (`export-beancount`): commodities, accounts (open/close), prices, transactions with cost/price annotations, balance assertions, `document` directives for stored attachments, metadata round-trip
- attachment lifecycle with async Paperless-ngx integration and background poller
- modular importer system via Python entry points
- Beancount importer with `source_native_id` and `document_url` round-trip fields
- MT940 importer
- Google Sheets client: Accounts, Transactions, Balances, Commodities, Attachments, Issues sheets
- Google Sheets: inline transaction editing (payee, narration, destination account, amount, splits)
- Google Sheets: Quick Add Transaction sidebar (simple and advanced modes)
- Google Sheets: Quick Filter with date range (year buttons + custom range) and account hierarchy filter
- Google Sheets: Importer Settings and Import Data dialog
- Google Sheets: `#,##0.00` number formatting on amount columns (Transactions, Balances)
- Google Sheets: free-text account search in the Quick Filter sidebar with intermediate prefix entries shown in italic

### Not Implemented

- `GET /prices` list endpoint (no list route exists; required to unblock the Prices sheet)
- account PATCH/update route
- cost/price display or editing in the Transactions sheet (those transactions are currently skipped at sync)
- Prices sheet in the Google Sheets client
- provenance metadata on sheet saves
- closing periods (edit gating + doctor scoping)
- snapshot export after import
- IBKR, payslip, and Visa Cumulus importers
- `document` Beancount import directive support
- Synology deployment and backup workflow

## Planned Work

### Backend

**`GET /prices` list endpoint**

Add a paginated list route consistent with all other collection endpoints. Required before the Prices sheet can be built.

**Account update route**

`PATCH /accounts/{account}` for mutable fields (`account_name`, `effective_end_date`, `entity_metadata`).

### Google Sheets — UX and display

**Quick Filter sidebar: performance and loading feedback**

The sidebar currently issues a single `getQuickFilterSidebarData` call on open that fetches years, active date range, account names, and the saved account prefix in one round-trip. Two areas to improve:

- *Loading state*: the account dropdown and year buttons show a generic "Loading…" spinner with no progress indication. Add per-section loading messages and surface errors inline rather than only in the status bar.
- *Performance*: the sidebar startup call reads the Accounts sheet and Transactions sheet synchronously. Investigate caching account names across sidebar opens (they rarely change) and lazy-loading the year list separately so the account dropdown can render without waiting for the full transaction scan.

**Cost/price: display**

Stop skipping transactions whose postings carry cost or price annotations. Render them in the Transactions sheet with cost/price fields displayed as read-only. This unblocks investment transactions that are currently invisible.

**Cost/price: editing**

Extend the editable fields (payee, narration, destination account, amount) to work on transactions with cost/price postings. Cost and price annotations themselves are not editable through the sheet.

**Prices sheet**

Fetch `/prices` and write a managed Prices sheet on sync, following the same pattern as the Balances sheet. Depends on the `GET /prices` backend endpoint.

**Provenance metadata**

Inject `generated_by: "google_sheets"` into `entity_metadata` on transaction PATCH calls made through the sheet. Expose stored metadata in the edit sidebar via a collapsible "Show metadata" section, rendered as a raw key-value list.

### New features

**Closing periods**

A configured close date divides the ledger into a closed period (before the date) and an open period (on or after the date).

Planned behavior:
- sheet edits on rows whose transaction date falls before the close date are blocked with a user-facing message
- `POST /ledger:doctor` is scoped to the open period only; issues in the closed period are suppressed

Open design question: whether the close date lives in Sheets document properties (per-spreadsheet, no backend change) or in `ledger.yaml` (authoritative for all clients). The server-side option is more correct but requires a backend change.

**Snapshot after import**

After a successful `POST /importers/{importer}:import` run, export the full ledger to a timestamped Beancount file (e.g. `backups/YYYY-MM-DDTHH:MM:SS-post-import.beancount`). Provides a recoverable checkpoint tied to each import event.

### Importers

- IBKR (Interactive Brokers activity statement)
- Payslip (PDF payslip parser)
- Visa Cumulus (CSV statement)

### Infrastructure

**Synology deployment and backup**

Document and script the Docker Compose deployment on a Synology host, including startup, shutdown, and periodic Beancount backup to the NAS filesystem.

**Beancount export parity**

Validate the `export-beancount` output against the original ledger in `projects/accounting` to confirm semantic equivalence before fully migrating to the new stack.

**`document` Beancount import directive**

Handle `document` directives when importing a Beancount file, creating attachment records linked to the referenced document URL.

## Deferred (no current plans)

- automatic pad write-back into the ledger
- richer booking methods beyond FIFO diagnostics in doctor
- HTTP Beancount export endpoint (CLI is sufficient)
- dedicated first-party web UI
- period locking and audit-history workflows
- spreadsheet-as-source-of-truth behavior
- asynchronous import orchestration or staged import item models
