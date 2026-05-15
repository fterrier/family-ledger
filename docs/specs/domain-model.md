# Domain Model

## Canonical Stored Entities

The current canonical model consists of:

- accounts
- commodities
- transactions
- postings
- prices
- balance assertions
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

Postings belong to transactions in explicit `posting_order` and carry:

- referenced account
- units amount and symbol
- optional narration
- optional per-unit cost pair
- optional per-unit price pair
- `entity_metadata`

`source_native_id` is the minimal import lineage key used for idempotent create-or-skip imports.

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

## Explicit Deferral

Attachments or document records are not part of the current canonical model.
