# Backend API

## General Rules

- `GET /healthz` is open
- all other routes require `Authorization: Bearer <token>`
- dates use `YYYY-MM-DD`
- decimal values are serialized as strings
- service errors are returned as:

```json
{
  "detail": {
    "code": "...",
    "message": "..."
  }
}
```

- list endpoints use `page_size` and `page_token` when implemented

## Consistent Create Semantics

All standard create endpoints share the same shape:

- method: `POST /{collection}`
- body: `application/json` with a wrapper object `{"<entity>": {...}}`
- success: `201 Created` with the created resource
- duplicate: `409 Conflict`

The duplicate check is enforced by a database unique constraint. Any attempt to create a record that violates the constraint returns `409` with `"code": "integrity_error"`. The unique keys are:

| Entity | Unique key |
|---|---|
| Account | `account_name` |
| Commodity | `symbol` |
| Transaction | `source_native_id` (when present; partial unique index) |
| Price | `(price_date, base_symbol, quote_symbol)` |
| Balance assertion | `(assertion_date, account, symbol)` |
| Attachment | `(account, original_filename, attachment_date)` |

Custom methods on existing resources (`:upload`, `:normalize`, `:pad`, `:import`) do not follow this create pattern and have their own documented semantics.

## Health

- `GET /healthz`

Response:

```json
{
  "status": "ok"
}
```

## Accounts

- `GET /accounts`
- `POST /accounts`
- `GET /accounts/{account}`
- `PATCH /accounts/{account}`
- `GET /accounts/{account}:pad?date=YYYY-MM-DD`

Accounts expose stable resource names such as `accounts/...` plus mutable `account_name` values.

`PATCH /accounts/{account}` accepts a full account payload and replaces `account_name`, `effective_start_date`, `effective_end_date`, and `entity_metadata`.

`GET /accounts/{account}:pad` is a read-only computation endpoint. It returns the postings a synthetic pad transaction would need for the first upcoming balance assertion per currency after the requested date.

## Commodities

- `GET /commodities`
- `POST /commodities`
- `GET /commodities/{commodity}`
- `PATCH /commodities/{commodity}`
- `DELETE /commodities/{commodity}`

## Transactions

- `GET /transactions`
- `POST /transactions`
- `GET /transactions/{transaction}`
- `PATCH /transactions/{transaction}`
- `DELETE /transactions/{transaction}`
- `POST /transactions:normalize`

`GET /transactions` also supports the current ad hoc filters:

- `from_date`
- `to_date`
- `account`

`POST /transactions:normalize` validates and normalizes a candidate transaction payload without persisting it. The persisted create and update routes use the same transaction shape but store canonical rows.

`PATCH /transactions/{transaction}` currently ignores `update_mask` and performs full transaction replacement.

## Prices

- `POST /prices`
- `GET /prices/{price}`

There is currently no `GET /prices` list endpoint.

## Balance Assertions

- `GET /balance-assertions`
- `POST /balance-assertions`
- `GET /balance-assertions/{balance_assertion}`
- `PATCH /balance-assertions/{balance_assertion}`
- `DELETE /balance-assertions/{balance_assertion}`

## Attachments

- `GET /attachments`
- `POST /attachments`
- `GET /attachments/{attachment}`
- `PATCH /attachments/{attachment}`
- `DELETE /attachments/{attachment}`
- `POST /attachments/{attachment}:upload`

Attachments are canonical ledger records that reference documents stored by an external backend.

`POST /attachments` accepts `application/json` and returns `201 Created`. It creates the metadata record only — no file is transferred. Supply `document_url` to link a pre-existing document directly (`stored` status), or omit it to create a record in `pending_upload` status awaiting a subsequent `:upload` call. Returns `409 Conflict` on duplicate `(account, original_filename, attachment_date)`.

`POST /attachments/{attachment}:upload` accepts `multipart/form-data` with a `file` field (and optional `title`). It uploads the file to the configured document backend and returns `202 Accepted`. Allowed from any attachment status; always resets to `pending_storage`.

The public attachment resource exposes these fields:

- `name`
- `account`
- `attachment_date`
- `original_filename`
- `media_type`
- `status`
- `document_url`
- `entity_metadata`
- `storage_metadata` — read-only informational object from the storage backend (see [attachment-storage.md](attachment-storage.md) for the field schema)

Attachment status values:

- `pending_upload`: record created, no file uploaded yet
- `pending_storage`: file accepted by the external backend, ingestion in progress
- `stored`: ingestion complete, `document_url` is available
- `failed`: external backend reported terminal failure
- `timed_out`: ingestion did not complete before the deadline

See [attachment-storage.md](attachment-storage.md) for the full status lifecycle and storage backend details.

## Diagnostics

- `POST /ledger:doctor`

Doctor returns derived issues, not canonical stored records. Current issue families include:

- `unbalanced_transaction`: posting amounts do not sum to zero within tolerance
- `account_not_effective`: a posting references an account whose effective date range does not cover the transaction date
- `unknown_commodity`: a posting references a symbol not present in the commodities table
- `lot_match_missing`: FIFO lot replay fails to find enough lots for a cost-tracked reduction
- `balance_assertion_failed`: running balance does not match a stored balance assertion within tolerance
- `attachment_pending_upload`: attachment record created but no file uploaded yet
- `attachment_storage_failed`: external backend reported terminal failure
- `attachment_storage_timed_out`: ingestion did not complete before the deadline

Each issue has the following fields:

| Field | Type | Description |
|---|---|---|
| `target` | string or null | Resource name of the affected entity |
| `code` | string | Machine-readable issue code (values above) |
| `severity` | string | Currently always `"error"` |
| `message` | string | Human-readable description |
| `details` | object | Code-specific key-value pairs (amounts, symbols, accounts) |
| `target_summary` | object | Snapshot of the target's key fields for display without a second API call |

## Importers

- `GET /importers`
- `PATCH /importers/{importer}`
- `POST /importers/{importer}:import`

Importer resource names use the installed plugin name, for example `importers/beancount`.

`PATCH /importers/{importer}` stores sparse persistent config for that importer.

`GET /importers` response includes a `file_descriptors` array per importer. Each descriptor has `name`, `label`, `description`, `accept`, and `required` fields. Importers that need more than one file declare multiple descriptors.

`POST /importers/{importer}:import` accepts multipart form data. Any number of named file fields may be uploaded; the names correspond to the importer's `file_descriptors`. A `config_override` field may optionally carry a JSON object string.

- `<file_descriptor_name>`: one or more named file uploads declared by the importer's `file_descriptors`
- `config_override`: optional JSON object encoded as a string

The service merges stored config with the one-off override, validates the merged result against the importer schema, and executes the import synchronously.

## Out Of Scope For This Spec

The current backend does not expose:

- an HTTP Beancount export endpoint (export is CLI-only via `export-beancount`)
- a `GET /prices` list endpoint
- price update or delete routes
