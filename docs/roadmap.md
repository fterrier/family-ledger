# Roadmap

This document tracks planned work, verified implementation state, and deferred scope. It supersedes the archived `archive/docs/roadmap-v0.1.md`.

## Implementation State

### Implemented

- canonical storage for accounts, commodities, transactions, postings, prices, balance assertions, attachments, importer config
- authenticated FastAPI routes for all canonical entity types (including `PATCH /accounts/{account}` for name, dates, metadata)
- `POST /ledger:doctor` — derived diagnostics: unbalanced transactions, FIFO lot failures, balance assertion failures, attachment issues
- `GET /accounts/{account}:pad` — on-demand pad computation
- `POST /transactions:normalize` — validation without persistence
- Beancount export CLI (`export-beancount`): commodities, accounts (open/close), prices, transactions with cost/price annotations, balance assertions, `document` directives for stored attachments, metadata round-trip
- attachment lifecycle with async Paperless-ngx integration and background poller
- modular importer system via Python entry points
- Beancount importer with `source_native_id`, `document_url` round-trip fields, and `document` directive import (`_import_documents`)
- MT940 importer — supports `provider_prefix` config to customise `source_native_id` prefix (e.g. `zkb` for ZKB files)
- ZKB PDF Kontoauszug importer
- IBKR (Interactive Brokers) importer via Flex XML reports
- Viseca One Card PDF importer with per-card account config and balance assertions
- Yahoo Finance price importer (`prices` entry point) — auto-discovers commodity pairs, resolves tickers from `entity_metadata.yahoo_ticker`
- Google Sheets client: Accounts, Transactions, Balances, Commodities, Attachments, Issues sheets
- Google Sheets: inline transaction editing (payee, narration, destination account, amount, splits); complex-posting transactions (cost/price) guard posting-modifying edits with a toast and allow payee/narration edits via narrow update mask
- Google Sheets: Quick Add Transaction sidebar (simple and advanced modes)
- Google Sheets: Quick Filter with date range (year buttons + custom range) and account hierarchy filter
- Google Sheets: Importer Settings and Import Data dialog
- Google Sheets: `#,##0.00` number formatting on amount columns (Transactions, Balances)
- Google Sheets: free-text account search in the Quick Filter sidebar with intermediate prefix entries shown in italic
- Google Sheets: all transactions displayed using weight-based model; cost/price transactions show settlement-currency amounts and are editable via the sidebar postings editor (cost and price per posting, individual toggles, account search with date filtering, move/reorder controls)
- Google Sheets: source account determined by posting order — first posting of each weight-symbol group is always the source; posting order in the ledger file is the control mechanism
- API: `weight` field returned per posting in transaction responses (computed from cost/price/units)
- API: `GET /prices` list endpoint with pagination; `PATCH /prices/{price}` update endpoint
- Google Sheets: Prices sheet — synced on every ledger sync, with create/edit/delete sidebar
- Google Sheets: incremental sync after import — only newly created resources are inserted for imports ≤ 200 entities; larger imports fall back to full sync
- Google Sheets: split on uncategorized/source-only rows — splitting creates a blank-destination posting; all edits (including partial states) are sent to the API immediately for real-time doctor visibility
- Synology deployment: Docker Compose stack running on Synology NAS with periodic Beancount export via `export-ledger` script

### Not Implemented

- provenance metadata on sheet saves
- closing periods (edit gating + doctor scoping)
- snapshot export after import

## Planned Work

### Google Sheets — UX and display

**Quick Filter sidebar: performance and loading feedback**

The sidebar currently issues a single `getQuickFilterSidebarData` call on open that fetches years, active date range, account names, and the saved account prefix in one round-trip. Two areas to improve:

- *Loading state*: the account dropdown and year buttons show a generic "Loading…" spinner with no progress indication. Add per-section loading messages and surface errors inline rather than only in the status bar.
- *Performance*: the sidebar startup call reads the Accounts sheet and Transactions sheet synchronously. Investigate caching account names across sidebar opens (they rarely change) and lazy-loading the year list separately so the account dropdown can render without waiting for the full transaction scan.

**Provenance metadata**

Inject `generated_by: "google_sheets"` into `entity_metadata` on transaction PATCH calls made through the sheet. Expose stored metadata in the edit sidebar via a collapsible "Show metadata" section, rendered as a raw key-value list.

### New features

**Closing periods**

A configured close date divides the ledger into a closed period (before the date) and an open period (on or after the date).

Planned behavior:
- sheet edits on rows whose transaction date falls before the close date are blocked with a user-facing message
- `POST /ledger:doctor` is scoped to the open period only; issues in the closed period are suppressed

Open design question: whether the close date lives in Sheets document properties (per-spreadsheet, no backend change) or in `ledger.yaml` (authoritative for all clients). The server-side option is more correct but requires a backend change.

**Reporting query endpoint + mobile account detail screen**

A read-only `POST /ledger:query` endpoint accepting a Beancount Query
Language (BQL) subset (backend implemented, incl. single-hop transitive
price conversion), plus a mobile Accounts browse screen and an account
detail screen with a balance-over-time chart (P0) and embedded transaction
list (P1). Full design: [specs/reporting-query.md](specs/reporting-query.md).

*Follow-up — currency fallback for unconvertible entries*: `convert()`
currently emits a `null` cell plus a `missing_price` warning when a currency
has no price path; frontends must display the warning. If that proves too
lossy in practice, fall back to expressing the unconvertible position in an
alternative currency (e.g. its cost currency) or return it unconverted in
the inventory, BQL-style.

**Snapshot after import**

After a successful `POST /importers/{importer}:import` run, export the full ledger to a timestamped Beancount file (e.g. `backups/YYYY-MM-DDTHH:MM:SS-post-import.beancount`). Provides a recoverable checkpoint tied to each import event.


## Deferred (no current plans)

- automatic pad write-back into the ledger
- richer booking methods beyond FIFO diagnostics in doctor
- HTTP Beancount export endpoint (CLI is sufficient)
- dedicated first-party web UI
- period locking and audit-history workflows
- spreadsheet-as-source-of-truth behavior
- asynchronous import orchestration or staged import item models
