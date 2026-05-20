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
- `GET /accounts/{account}:pad?date=YYYY-MM-DD`

Accounts expose stable resource names such as `accounts/...` plus mutable `account_name` values.

`GET /accounts/{account}:pad` is a read-only computation endpoint. It returns the postings a synthetic pad transaction would need for the first upcoming balance assertion per currency after the requested date.

## Commodities

- `GET /commodities`
- `POST /commodities`
- `GET /commodities/{commodity}`

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

## Attachments

- `GET /attachments`
- `POST /attachments`
- `GET /attachments/{attachment}`

Attachments are canonical ledger records that reference documents stored by an external backend.

`POST /attachments` accepts `multipart/form-data` with:

- `file`: uploaded file
- `account`: required account resource name
- `attachment_date`: required date
- `title`: optional user-facing title hint for the storage backend
- `entity_metadata`: optional JSON object encoded as a string

The backend uploads the file to the configured document backend and returns `202 Accepted` once the external ingestion task has been started successfully.

The public attachment resource exposes only canonical fields:

- `name`
- `account`
- `attachment_date`
- `original_filename`
- `media_type`
- `status`
- `document_url`
- `entity_metadata`

Attachment status values are currently:

- `pending_storage`
- `stored`
- `failed`
- `timed_out`

## Diagnostics

- `POST /ledger:doctor`

Doctor returns derived issues, not canonical stored records. Current issue families include:

- transaction balancing issues
- FIFO lot replay failures for cost-tracked reductions
- balance assertion failures
- attachment storage failures
- attachment storage timeouts

## Importers

- `GET /importers`
- `PATCH /importers/{importer}`
- `POST /importers/{importer}:import`

Importer resource names use the installed plugin name, for example `importers/beancount`.

`PATCH /importers/{importer}` stores sparse persistent config for that importer.

`POST /importers/{importer}:import` accepts multipart form data:

- `file`: uploaded file
- `config_override`: optional JSON object encoded as a string

The service merges stored config with the one-off override, validates the merged result against the importer schema, and executes the import synchronously.

## Out Of Scope For This Spec

The current backend does not expose:

- an HTTP Beancount export endpoint
- account patch/update routes
- commodity or price update/delete routes
