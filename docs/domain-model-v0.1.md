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
- issue
- price
- balance assertion
- attachment

There is no separate canonical `import_job`, `import_item`, `inventory`, or `lot` table in v1.

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
- `fingerprint`

Notes:
- `name` is the stable API resource name built from an opaque key, for example `transactions/txn_01jv3m0r7x8c`.
- Transactions do not have a dedicated status field in v1.
- Transactions may be balanced or unbalanced.
- Validation fields are not stored on transaction rows themselves.
- Persisted issues are separate records linked to stored entities and may be returned inline by read APIs.
- Transactions may be categorized or uncategorized; that is also a derived property.
- Fingerprints are persisted and recomputed on transaction writes.
- The API may group the two dedupe fields under a nested `import_metadata` object, but the DB model keeps them flattened for queryability and uniqueness constraints.
- `fingerprint` is a duplicate hint and lookup aid, not a globally unique transaction identity.

## Issues

Issues are persisted diagnostics attached to stored ledger entities.

Recommended fields:
- `id`
- `name`
- `target`
- `code`
- `severity`
- `message`
- optional `details`

Notes:
- `name` is the stable API resource name built from an opaque key.
- `target` references the affected resource, such as a transaction.
- Issues are derived from stored state and persisted separately from the target record.
- Multiple issues may exist for one target.
- In v1, issues are used to surface storable-but-invalid states such as unbalanced transactions.

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
- `fingerprint`

Rules:
- Use native ID for idempotency when available.
- Fall back to fingerprint when native ID is unavailable.
- Store both when both are available; matching priority is native ID first, fingerprint second.
- Re-import must be idempotent with respect to existing transactions.
- Imports never overwrite an existing matching transaction in v1; they create-or-skip only.
- The stored fingerprint is recomputed on each transaction write from canonical transaction content: transaction date, payee, narration, and ordered postings including account, units, optional cost, and optional price.
- Fingerprint computation excludes `source_native_id` and free-form metadata.
- Fingerprints are not globally unique because repeated identical transactions may legitimately exist.

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
- persisted issues flag them as invalid

## Validation Rules

The v1 model should enforce or compute these rules:
- transactions referencing accounts outside account effective dates are invalid
- strict double-entry balancing is the target accounting rule, but imbalance does not block persistence in v1 when the transaction can still be stored explicitly
- balance assertions must validate under project-level tolerance rules
- reducing postings held at cost use strict booking semantics
- strict booking means:
  - unique match succeeds
  - total-match across all matching lots succeeds
  - ambiguous partial matches fail

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
- persisted issues for stored entities, such as unbalanced transactions
- importer-specific static settings
- export policy settings if needed
- accounts
- commodities
- transactions
- postings
- issues
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
- non-unique indexed `transactions.fingerprint`

## Deferred Beyond v1

These are intentionally deferred:
- audit history and change logging
- field-level locking
- account-level booking methods
- import-job and import-item staging layers
- persisted inventory or lot caches
- attachment ownership links beyond optional account reference
- auth and permissions
- filtered export
