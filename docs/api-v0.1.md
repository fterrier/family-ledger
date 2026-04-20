# Family Accounting Platform API v0.1

## Purpose

Define the minimum v1 API surface needed to implement the ledger core without semantic drift.

This document describes the external HTTP contract, not the internal persistence model. It stays intentionally narrow and only covers the v1 endpoints needed for ledger writes, reads, validation visibility, imports, prices, assertions, and export.

## API Principles

- The API is the write surface for the canonical database.
- The API should follow relevant `aip.dev` guidance where practical, especially for resource-oriented design, naming, and standard methods.
- Deviations from `aip.dev` should be explicit and justified by ledger semantics.
- The API exposes canonical ledger data without embedding validation state into resources.
- The API does not enforce field-level locking in v1.
- There is no auth in v1.
- Money-like value objects use ledger symbols such as `CHF`, `USD`, and `GOOG`, not commodity resource names.

## Envelope Conventions

- All request and response bodies use JSON.
- Dates use ISO `YYYY-MM-DD` format.
- Decimal values are serialized as strings.
- Resources use stable resource `name` fields as their canonical external identifier.
- Validation problems should be reported as structured errors rather than hidden or auto-corrected.
- Response codes should follow relevant `aip.dev` guidance; missing top-level resources are `404`, but invalid request bodies and unsatisfied request preconditions should generally use `400`-class validation-style errors rather than `404`.

## Core Resource Shapes

### Money-Like Values

Use this shape for units, costs, prices, and assertions:

```json
{
  "amount": "100.00",
  "symbol": "CHF"
}
```

### Posting

```json
{
  "account": "accounts/bank-checking-family",
  "units": {
    "amount": "-100.00",
    "symbol": "USD"
  },
  "cost": {
    "amount": "120.00",
    "symbol": "USD"
  },
  "price": {
    "amount": "0.92",
    "symbol": "CHF"
  },
  "entity_metadata": {}
}
```

Notes:
- `cost` is optional.
- `price` is optional.
- `cost` and `price` are per-unit values only in v1.
- `account` is the stable account resource name, not the mutable Beancount export name.
- `entity_metadata` is optional.

### Transaction

```json
{
  "name": "transactions/txn-123",
  "transaction_date": "2026-04-19",
  "payee": "Migros",
  "narration": "Groceries",
  "entity_metadata": {},
  "import_metadata": {
    "source_native_id": null,
    "fingerprint": "sha256:deadbeef"
  },
  "postings": []
}
```

Notes:
- Transaction resources do not embed validation state in v1.
- `import_metadata` is optional.
- `fingerprint` is stored on transactions and updated on transaction writes.

### Account

```json
{
  "name": "accounts/bank-checking-family",
  "ledger_name": "Assets:Bank:Checking:Family",
  "effective_start_date": "2020-01-01",
  "effective_end_date": null,
  "entity_metadata": {}
}
```

Notes:
- `name` is the stable API resource name.
- `ledger_name` is the mutable hierarchical Beancount export name.

### Price Record

```json
{
  "name": "prices/price-123",
  "price_date": "2026-04-19",
  "base_symbol": "USD",
  "quote": {
    "amount": "0.92",
    "symbol": "CHF"
  },
  "entity_metadata": {}
}
```

### Balance Assertion

```json
{
  "name": "balanceAssertions/bal-123",
  "assertion_date": "2026-04-19",
  "account": "accounts/bank-checking-family",
  "amount": {
    "amount": "1000.00",
    "symbol": "CHF"
  },
  "entity_metadata": {}
}
```

### Commodity

```json
{
  "name": "commodities/chf",
  "symbol": "CHF",
  "entity_metadata": {}
}
```

## Health Endpoint

### `GET /healthz`

Purpose:
- process-level health check

Response:

```json
{
  "status": "ok"
}
```

## Accounts API

### `GET /accounts`

Purpose:
- list accounts

Query parameters:
- `page_size` optional
- `page_token` optional

Behavior:
- returns accounts in a stable order
- supports AIP-style pagination with `next_page_token`

### `POST /accounts`

Purpose:
- create an account

Example request body:

```json
{
  "account": {
    "name": "accounts/bank-checking-family",
    "ledger_name": "Assets:Bank:Checking:Family",
    "effective_start_date": "2020-01-01"
  }
}
```

Expected fields:
- `name`
- `ledger_name`
- `effective_start_date`
- `effective_end_date` optional
- `entity_metadata` optional

Validation:
- account name must be unique
- account resource name must be stable and unique
- `ledger_name` must follow Beancount-style hierarchy naming
- `effective_end_date`, if present, must not be before `effective_start_date`

### `GET /accounts/{account}`

Purpose:
- fetch one account

### `PATCH /accounts/{account}`

Purpose:
- update account fields

Validation:
- changes that make existing transaction references invalid should fail unless the caller updates the affected transactions separately
- changing `ledger_name` does not require rewriting stored postings because postings reference the stable account resource name

## Commodities API

### `GET /commodities`

Purpose:
- list commodities

Query parameters:
- `page_size` optional
- `page_token` optional

Behavior:
- returns commodities in a stable order
- supports AIP-style pagination with `next_page_token`

### `POST /commodities`

Purpose:
- create a commodity used by postings or prices

Example request body:

```json
{
  "commodity": {
    "name": "commodities/chf",
    "symbol": "CHF"
  }
}
```

Expected fields:
- `name`
- `symbol`
- `entity_metadata` optional

### `GET /commodities/{commodity}`

Purpose:
- fetch one commodity

## Transactions API

### `GET /transactions`

Purpose:
- list transactions

Minimum query parameters:
- `from_date` optional
- `to_date` optional
- `account` optional
- `fingerprint` optional
- `page_size` optional
- `page_token` optional

Behavior:
- returns stored transactions, including unbalanced transactions
- validation is handled separately and is not embedded into transaction resources in v1
- returns transactions in a stable order
- supports AIP-style pagination with `next_page_token`

### `POST /transactions`

Purpose:
- create a transaction with postings

Example request body:

```json
{
  "transaction": {
    "transaction_date": "2026-04-19",
    "payee": "Migros",
    "narration": "Groceries",
    "import_metadata": {
      "source_native_id": "abc123",
      "fingerprint": "sha256:deadbeef"
    },
    "postings": [
      {
        "account": "accounts/bank-checking-family",
        "units": {
          "amount": "-100.00",
          "symbol": "CHF"
        }
      },
      {
        "account": "accounts/expenses-uncategorized",
        "units": {
          "amount": "100.00",
          "symbol": "CHF"
        }
      }
    ]
  }
}
```

Expected fields:
- `transaction_date`
- `payee` optional
- `narration` optional
- `entity_metadata` optional
- `import_metadata` optional
- `postings`

Validation:
- each posting must reference an existing account
- posting account must be effective on `transaction_date`
- each `symbol` used by `units`, `cost`, or `price` must already exist as a commodity
- `cost` and `price` must be per-unit values only
- unbalanced transactions may still be persisted in v1
- strict cost-based matching errors must be reported for reducing postings when applicable

Response:
- returns the persisted transaction resource

### `GET /transactions/{transaction_id}`

Purpose:
- fetch one transaction

### `PATCH /transactions/{transaction_id}`

Purpose:
- replace the mutable transaction payload, including the full postings array

Example request body:

```json
{
  "transaction": {
    "name": "transactions/txn-123",
    "transaction_date": "2026-04-19",
    "payee": "Migros",
    "narration": "Updated groceries",
    "import_metadata": {
      "source_native_id": "abc123",
      "fingerprint": "sha256:updated"
    },
    "postings": []
  },
  "update_mask": "payee,narration,import_metadata,postings"
}
```

Behavior:
- partial posting mutation semantics are not part of v1
- `update_mask` is present for AIP consistency, but v1 implementations may ignore it and apply replacement-style updates
- implementations should recompute and persist `import_metadata.fingerprint` on transaction writes

Validation:
- same as `POST /transactions`

### `DELETE /transactions/{transaction_id}`

Purpose:
- remove a transaction

Note:
- hard delete is acceptable in v1 unless later requirements introduce a softer deletion model
- deleting a transaction also deletes its dedupe metadata, so a later import may recreate it

## Prices API

### `GET /prices`

Purpose:
- list price history records

Minimum query parameters:
- `base_symbol` optional
- `quote_symbol` optional
- `from_date` optional
- `to_date` optional

### `POST /prices`

Purpose:
- create a price record

Example request body:

```json
{
  "price": {
    "price_date": "2026-04-19",
    "base_symbol": "USD",
    "quote": {
      "amount": "0.92",
      "symbol": "CHF"
    }
  }
}
```

Expected fields:
- `price_date`
- `base_symbol`
- `quote.amount`
- `quote.symbol`
- `entity_metadata` optional

### `GET /prices/{price}`

Purpose:
- fetch one price record

## Balance Assertions API

### `GET /balance-assertions`

Purpose:
- list assertions

### `POST /balance-assertions`

Purpose:
- create a balance assertion

Example request body:

```json
{
  "balance_assertion": {
    "assertion_date": "2026-04-19",
    "account": "accounts/bank-checking-family",
    "amount": {
      "amount": "1000.00",
      "symbol": "CHF"
    }
  }
}
```

Expected fields:
- `assertion_date`
- `account`
- `amount.amount`
- `amount.symbol`
- `entity_metadata` optional

Behavior:
- assertion validation is handled separately and may report failures later without removing the assertion resource

### `GET /balance-assertions/{assertion}`

Purpose:
- fetch one assertion

## Attachments API

### `GET /attachments`

Purpose:
- list attachments

### `POST /attachments`

Purpose:
- create an attachment record

Example request body:

```json
{
  "attachment": {
    "account": "accounts/bank-checking-family",
    "storage_key": "attachments/2026-04/statement.pdf",
    "original_filename": "statement.pdf"
  }
}
```

Expected fields:
- `account` optional
- `storage_key`
- `original_filename`
- `media_type` optional
- `attachment_date` optional
- `entity_metadata` optional

### `GET /attachments/{attachment}`

Purpose:
- fetch one attachment record

## Import API

Imports in v1 operate directly on transactions rather than through a separate staged import entity.

### `POST /imports/{source_type}`

Purpose:
- ingest import payloads for a concrete source type

Behavior:
- parse input into one or more transactions
- use `import_metadata.source_native_id` when available
- fall back to `import_metadata.fingerprint` otherwise
- create new transactions when no match exists
- leave matching transactions untouched when either identifier already matches an existing transaction

Response:

```json
{
  "created": 0,
  "updated": 0,
  "untouched": 0,
  "errors": []
}
```

Note:
- the concrete request payload depends on the source type and may vary by importer
- importer-specific payload contracts do not need to be standardized in this document yet

## Export API

### `GET /export/beancount`

Purpose:
- export the full ledger in deterministic Beancount form

Behavior:
- full-ledger export only in v1
- no filtered export in v1
- unbalanced transactions may still appear in the export
- attachments are not exported in v1

Response:
- `text/plain`

## Error Shape

Validation and domain errors should use a consistent JSON shape.

```json
{
  "error": {
    "code": "transaction_unbalanced",
    "message": "Transaction does not balance",
    "details": {
      "transaction_id": "txn_123"
    }
  }
}
```

Recommended error codes include:
- `account_not_found`
- `account_not_effective`
- `commodity_not_found`
- `transaction_unbalanced`
- `lot_match_ambiguous`
- `lot_match_missing`
- `balance_assertion_failed`
- `import_conflict`
- `invalid_request`

## Phase 2 Minimum Implementation Slice

The first implementation slice should support:
- `GET /healthz`
- `POST /accounts`
- `GET /accounts`
- `POST /commodities`
- `POST /transactions`
- `GET /transactions/{transaction_id}`
- `POST /prices`
- `POST /balance-assertions`

That is enough to establish the core schema, writes, reads, and validation flow before import and export work expands.
