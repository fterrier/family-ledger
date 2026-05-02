# Family Accounting Platform Domain Model v0.1

## Purpose

Define the canonical v1 data model for the ledger.

This document describes the runtime source of truth stored in the database. It is intentionally small and aligned with the compatibility target. It does not attempt to model every Beancount directive or every future workflow.

## Modeling Principles

- The database is canonical.
- Transactions and postings are the core accounting model.
- Inventory and lots are derived from postings; they are not stored as separate canonical records in v1.
- Keep accounting semantics close to Beancount while keeping the runtime model DB-native.
- Prefer explicit validations over hidden automatic behavior.
- Keep policy in project config files and ledger state in the database.

## Canonical Entities

The canonical v1 entities are:
- account
- commodity
- transaction
- posting
- price
- balance assertion
- attachment
- importer

There is no separate canonical `issue`, `import_job`, `import_item`, `inventory`, or `lot` table in v1.

Ledger diagnostics are derived from canonical ledger data and exposed through `POST /ledger:doctor`; they are not persisted as canonical records.

## Accounts

Accounts represent the chart of accounts used by transactions and assertions.

Recommended fields:
- `id`
- `name`
- `account_name`
- `effective_start_date`
- `effective_end_date` nullable
- optional `entity_metadata`

Notes:
- `name` is the stable API resource name built from an opaque key, for example `accounts/acc_01jv3m0r7x8c`.
- `account_name` is the mutable Beancount-compatible hierarchy name, for example `Assets:Bank:Checking:Family`.
- Hierarchy is encoded by `:`-separated segments in `account_name`; for example `Expenses:Stuff:Things` is inside `Expenses:Stuff`, which is inside `Expenses`.
- Account type is implied by the root name segment of `account_name`: `Assets`, `Liabilities`, `Equity`, `Income`, or `Expenses`.
- `open` and `close` semantics are modeled through the effective date fields.
- Commodity constraints, if any, come from project config rather than from a separate v1 account-role system.
- Postings reference stable account identity rather than `account_name`, so account renames and hierarchy changes do not require rewriting postings.

## Commodities

Commodities represent currencies, securities, and other countable units used by postings and prices.

Recommended fields:
- `id`
- `name`
- `symbol`
- optional `entity_metadata`

Notes:
- `name` is the stable API resource name built from an opaque key, for example `commodities/cmd_01jv3m0r7x8c`.
- `symbol` is the canonical ledger symbol used in postings, prices, and assertions, for example `CHF`.
- Additional metadata may exist, but core accounting logic should not depend on arbitrary metadata.
- Runtime writes reference commodity symbols strictly; symbols used by transactions, prices, and assertions are expected to exist as commodity rows.

## Transactions

Transactions are groups of postings that represent accounting events.

Recommended fields:
- `id`
- `name`
- `transaction_date`
- `payee` nullable
- `narration` nullable
- optional `entity_metadata`
- `source_native_id` nullable

Notes:
- `name` is the stable API resource name built from an opaque key, for example `transactions/txn_01jv3m0r7x8c`.
- Transactions do not have a dedicated status field in v1.
- Transactions may be balanced or unbalanced.
- Validation fields are not stored on transaction rows themselves.
- Transactions may be categorized or uncategorized; that is also a derived property.
- The API may expose `source_native_id` under a nested `import_metadata` object, but the DB model keeps it flattened for queryability and uniqueness constraints.

## Postings

Postings are the atomic accounting legs of transactions.

Recommended fields:
- `id`
- `transaction_id`
- `account_id`
- `posting_order`
- `units_amount`
- `units_symbol`
- optional `cost_per_unit`
- optional `cost_symbol`
- optional `price_per_unit`
- optional `price_symbol`
- optional `entity_metadata`

### Posting Semantics

A posting always has units and may optionally have cost and price annotations.

Canonical v1 forms:
- units only
- units plus price
- units plus cost
- units plus cost plus price

Examples:
- `100 USD`
- `-100 USD @ 0.92 CHF`
- `10 GOOG {120 USD}`
- `-5 GOOG {120 USD} @ 135 USD`

Notes:
- Cost is stored only as per-unit cost in v1.
- Price is stored only as per-unit price in v1.
- Total-price input forms are not part of the canonical v1 model.
- Cost does not include separate date or label fields in v1.
- Canonical stored postings always have explicit `units_amount` and `units_symbol`.
- Incomplete postings are not part of stored ledger state.
- Any normalization or interpolation must happen before persistence.
- The API may accept a narrow incomplete transaction form temporarily at the write boundary, but the persisted result is always explicit.
- Pre-persistence normalization follows Beancount balancing-weight semantics: cost wins over price for balancing, price is used only when cost is absent, and units are used only when neither cost nor price is present.
- Current normalization support remains limited to one missing posting, but that posting may expand into multiple explicit postings when Beancount balancing weights span multiple symbols.
- Current normalization may also infer one missing `units.symbol` when the balancing result implies exactly one symbol.
- Current normalization may also fill in one missing `price.amount` per balancing symbol group when the result is unambiguous.
- Postings are their own DB table for queryability and ledger computation, but they are not a standalone mutable API resource in v1.

## Prices

Prices represent point-in-time valuation relationships between commodities.

Recommended fields:
- `id`
- `name`
- `price_date`
- `base_symbol`
- `quote_symbol`
- `price_per_unit`
- optional `entity_metadata`

Notes:
- `name` is the stable API resource name built from an opaque key, for example `prices/prc_01jv3m0r7x8c`.
- Prices are distinct from posting price annotations.
- A posting price annotation records the price attached to that posting.
- A price record belongs to the global price history.

## Balance Assertions

Balance assertions are separate ledger records, not a transaction subtype.

Recommended fields:
- `id`
- `name`
- `assertion_date`
- `account_id`
- `amount`
- `symbol`
- optional `entity_metadata`

Notes:
- `name` is the stable API resource name built from an opaque key, for example `balanceAssertions/bal_01jv3m0r7x8c`.
- Balance assertions are validated against derived account balances as of `assertion_date`.
- Validation uses posting units only for the asserted symbol; posting cost and price annotations do not affect the result.
- Validation includes the asserted account and all descendant subaccounts.
- Validation compares the derived units for the asserted symbol against the asserted amount under project-level tolerance rules.
- Validation results are derived from stored ledger data and are not persisted on the assertion record.
- Project-level tolerance rules come from config.

## Importers

Importers bind a file-parsing plugin to a user-defined configuration.

Recommended fields:
- `id`
- `name`
- `plugin_name`
- `config`

Notes:
- `name` is the stable API resource name built from an opaque key, for example `importers/imp_01jv3m0r7x8c`.
- `plugin_name` maps the DB record to a specific Python parser class (e.g., `beancount`).
- `config` is a JSONB column containing user preferences (e.g., default account assignments).
- `display_name` is defined on the parser class in code and is not stored in the database. The API injects it at query time from the in-memory parser registry.
- Importers are automatically bootstrapped 1:1 with Python parsers on application startup via entry point discovery.

## Attachments

Attachments exist independently in v1.

Recommended fields:
- `id`
- `name`
- `account_id` nullable
- storage location or file path reference
- original filename
- media type nullable
- attachment date nullable
- optional `entity_metadata`

Notes:
- Attachments do not need transaction or import ownership links in v1.
- Attachments are not exported in v1.

## Transaction Dedupe Metadata

Transactions carry only minimal dedupe metadata in v1.

Required fields:
- `source_native_id` nullable

Rules:
- Each importer assigns a namespaced `source_native_id` of the form `"{importer}:{stable_id}"` (e.g. `"mt940:Z1234"`, `"beancount:fp:sha256:..."`).
- When the importer has a bank-assigned or file-level reference, it uses it directly.
- When no native reference exists, the importer computes a deterministic hash of key transaction fields plus an occurrence index (how many identical-looking transactions have already appeared in the same import batch).
- The occurrence-index approach ensures the ID is stable across re-imports of the same file while producing distinct IDs for genuinely duplicate transactions within one batch.
- Re-import must be idempotent with respect to existing transactions.
- Imports never overwrite an existing matching transaction in v1; they create-or-skip only.
- Known limitation: if two overlapping statements each contain a distinct transaction with identical fields and no bank-assigned reference, the second import will skip the transaction as a duplicate.

## Derived Concepts

The following are derived from canonical ledger data rather than stored as separate v1 records.

### Inventory

Inventory is the accumulated content of an account after replaying postings in date order.

### Lots

Lots are derived held-at-cost positions within account inventory.

In v1:
- lots are created by augmenting postings with cost
- reducing postings match prior lots by commodity and per-unit cost
- there is no persisted lot table
- there is no persisted booking cache

### Categorization

Categorization is derived from postings and project config.

In v1:
- uncategorized placeholder account names are defined in config
- a transaction is uncategorized if one of its postings uses a configured uncategorized placeholder account
- imports may balance transactions against those placeholder accounts
- uncategorized transactions are valid ledger entries, not errors

### Balance Validity

Balance validity is derived from transaction postings.

In v1:
- transactions may remain unbalanced in the stored ledger
- unbalanced transactions are included in ledger reads and exports
- derived diagnostics flag them as invalid when the ledger is checked

### Lot Booking Diagnostics

Lot-booking diagnostics are derived from stored postings and are not persisted.

In v1:
- `ledger:doctor` replays held-at-cost postings by exact lot bucket
- the exact lot bucket is `account + units_symbol + cost_symbol + cost_per_unit`
- postings in the same transaction and same exact lot bucket are aggregated before booking checks
- the implemented booking method is FIFO only
- the replay logic should live in a dedicated booking component so doctor and any future inventory projection can share the same reduction behavior
- the replay engine is intended to grow toward additional Beancount-like booking methods later
- lot date and lot label are not part of the stored v1 lot identity yet

## Validation Rules

The v1 model should enforce or compute these rules:
- transactions referencing accounts outside account effective dates are invalid
- strict double-entry balancing is the target accounting rule, but imbalance does not block persistence in v1 when the transaction can still be stored explicitly
- balance assertions must validate under project-level tolerance rules
- reducing postings held at cost are checked through derived FIFO lot-booking diagnostics in v1

There is no support for per-account booking methods in v1.

## Config vs Database Boundary

### Config-Owned

Project config files own:
- tolerance settings
- operating/default currency
- uncategorized placeholder account names

### Database-Owned

The database owns:
- canonical stored transactions and postings
- persistent importer configurations (`config`)
- export policy settings if needed
- accounts
- commodities
- transactions
- postings
- prices
- balance assertions
- attachments
- dedupe metadata stored on transactions

## Constraints

The v1 schema should enforce at least these uniqueness constraints:
- unique `accounts.name`
- unique `accounts.account_name`
- unique `commodities.name`
- unique `commodities.symbol`
- unique `transactions.source_native_id` when non-null

## Deferred Beyond v1

These are intentionally deferred:
- audit history and change logging
- field-level locking
- account-level booking methods
- import-job and import-item staging layers
- persisted inventory or lot caches
- attachment ownership links beyond optional account reference
- advanced auth, permissions, and multi-user authorization policy
- filtered export
