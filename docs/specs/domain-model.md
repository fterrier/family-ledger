# Domain Model

## Canonical Stored Entities

The current canonical model consists of:

- accounts
- commodities
- transactions
- postings
- prices
- balance assertions
- attachments
- importer config rows

## Accounts

Accounts are canonical resources with:

- stable resource name `accounts/...`
- mutable `account_name`
- `effective_start_date`
- optional `effective_end_date`
- arbitrary `entity_metadata`

Account lifecycle constraints are enforced through effective dates rather than first-class `open` and `close` directive objects.

## Commodities

Commodities map a stable resource name `commodities/...` to a ledger symbol such as `CHF`, `USD`, or a security symbol.

## Transactions And Postings

Transactions are stored as canonical explicit postings.

Transaction fields:

- stable resource name `transactions/...`
- `transaction_date`
- optional `payee`
- optional `narration`
- `entity_metadata`
- optional unique `source_native_id`
- optional `import_metadata` — carries `source_native_id` as an alternative input path on create/normalize; not stored as a separate column

Postings belong to transactions in explicit `posting_order` and carry:

- optional referenced account — `null` represents an unassigned posting (money not yet categorized to any account); stored as a true null, never a placeholder value, and excluded from doctor's balance check and from `/query`
- units amount and symbol
- optional narration
- optional per-unit cost pair (amount + symbol)
- optional per-unit price pair (amount + symbol)
- `entity_metadata`

`source_native_id` is the minimal import lineage key used for idempotent create-or-skip imports. It may be supplied either directly on the transaction or inside `import_metadata`.

### Normalization

Canonical stored postings must be fully explicit (real `units.amount`, `units.symbol`, and any `price.amount` present). Normalization is the one server-side place a caller may submit a narrowly incomplete payload and have the gaps filled in — every client shares this instead of reimplementing interpolation itself. See ADR 0006.

What may be left incomplete, each independently, at most one posting per payload (except the last, which is at most one per balancing-symbol group):

- one posting may omit `units` entirely
- one posting may give `units.amount` but omit `units.symbol`
- one posting per balancing-symbol group may give `price` but omit `price.amount`
- `cost` is never inferred — a posting must specify it explicitly or not at all

The computation: sum every posting's *balancing weight* per symbol, across the *whole* payload — unassigned postings included. A posting's weight is its cost-adjusted value if it has a `cost`, else its price-adjusted value if it has a `price`, else its raw `units` amount/symbol (cost wins over price if somehow both are present). This full-payload sum is deliberately the same one used to decide whether a filler posting is needed (below), and deliberately *not* the accounted-only sum used for doctor's "still needs categorizing" check — normalization is arithmetic to make numbers add up, not a categorization question. See ADR 0006's addendum and ADR 0012 for why conflating the two was a real, twice-found bug (a loud one for the missing-`units` case, a *silent* wrong-value one for the missing-`price.amount` case).

Given that sum, each incomplete posting is resolved:

- missing `units` → expands into one new posting *per symbol* present in the sum, each amount the negation of that symbol's total (a multi-currency payload can turn one incomplete posting into several explicit ones)
- missing `units.symbol` → filled in from the sum's symbol, but only when the sum has exactly one distinct symbol
- missing `price.amount` → computed as `-(that symbol's total in the sum) / units.amount`

A posting that's already fully explicit passes through unchanged. Ambiguous or contradictory input (more than one posting omits the same thing, an omission combined with `cost`/`price` it can't coexist with, nothing in the payload to balance against, more than one candidate symbol) is rejected rather than guessed.

### Balance Filling On Write

Normalization always runs first and never adds a posting — it only fills in blanks on postings the caller already sent. Balance filling is the separate, later step that runs on normalization's *output*: whenever a transaction's postings are (re)written — create, update, `:split`, `:unsplit`, or import — the persistence layer appends one additional unassigned posting per currency if the now-fully-explicit postings still don't sum to zero within tolerance. A transaction's stored postings are therefore always fully balanced; an unassigned posting is how a structural gap (a single-leg import, a not-yet-fully-categorized transaction, a split's remainder) is made visible and editable, rather than a separate derived diagnostic. `POST /transactions:normalize` runs this same step itself (since it never reaches the persistence layer) to preview the filler without storing it. See ADR 0012.

## Prices

Prices store a base symbol, quote symbol, date, and per-unit quoted amount.

## Balance Assertions

Balance assertions store:

- stable resource name `balanceAssertions/...`
- assertion date
- referenced account
- asserted amount and symbol
- `entity_metadata`

They are canonical stored rows. Validation of whether they currently hold is derived separately through doctor and pad logic.

## Attachments

Attachments are canonical records that associate an uploaded document with a ledger account and date while delegating binary storage to an external document backend.

Attachment fields:

- stable resource name `attachments/...`
- referenced account
- `attachment_date`
- `original_filename`
- optional `media_type`
- `status`
- optional `document_url`
- `entity_metadata`

The canonical attachment contract is intentionally narrow.

- the attachment record belongs to the ledger domain
- the binary file is stored by an external backend such as Paperless-ngx
- backend-specific ingestion state is internal implementation detail rather than public API contract
- `document_url` is the canonical external reference once storage succeeds

Current required linkage is account-level. Transaction-level linkage is not part of the current contract.

## Importer Config

Importer persistence is intentionally small.

- importer rows are keyed by `plugin_name`
- only sparse persistent `config` is stored
- importer schema and display name come from the installed plugin at runtime

## Derived, Not Canonical

The following are derived outputs rather than canonical entities:

- doctor issues
- normalized transaction candidates returned by `POST /transactions:normalize`
- pad computations returned by `GET /accounts/{account}:pad`
