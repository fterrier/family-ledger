# Attachment Storage

## Purpose

Attachments associate ledger-relevant documents with accounts and dates while delegating binary storage and ingestion to an external document backend.

The current backend integration target is Paperless-ngx.

## Public Contract

Attachments are exposed through a narrow ledger-facing API.

Public attachment fields:

- `name`
- `account`
- `attachment_date`
- `original_filename`
- `media_type`
- `status`
- `document_url`
- `entity_metadata`
- `storage_metadata`

`storage_metadata` is a read-only informational object populated by the storage backend. Its schema is not part of the API contract but the known fields are:

| Field | Type | When present |
|---|---|---|
| `document_id` | int | attachment is `stored` via Paperless |
| `duplicate_of` | int | Paperless reported the file already existed |
| `task_id` | string | ingestion task in progress |
| `submitted_at` | ISO timestamp | upload was submitted |
| `last_checked_at` | ISO timestamp | poller last polled the task |
| `completed_at` | ISO timestamp | ingestion reached a terminal state |

The `document_id` field is the most actionable: it is the Paperless document identifier referenced when downloading documents during Beancount export.

The API does not expose raw provider errors or the storage backend identifier.

## API Shape

```
GET  /attachments
POST /attachments
GET  /attachments/{attachment}
POST /attachments/{attachment}:upload
```

### POST /attachments — create attachment record

Accepts `application/json`:

```json
{
  "attachment": {
    "account": "accounts/...",
    "attachment_date": "YYYY-MM-DD",
    "original_filename": "statement.pdf",
    "media_type": "application/pdf",
    "document_url": null,
    "entity_metadata": {}
  }
}
```

Required fields: `account`, `attachment_date`, `original_filename`.

Returns `201 Created` with the attachment resource.

If `document_url` is supplied the attachment is created directly in `stored` status — no file upload is needed.

If `document_url` is omitted the attachment is created in `pending_upload` status; a subsequent `:upload` call is required.

Returns `409 Conflict` if an attachment with the same `(account, original_filename, attachment_date)` already exists.

### POST /attachments/{attachment}:upload — upload file to storage backend

Accepts `multipart/form-data`:

- `file`: uploaded file (required)
- `title`: optional title hint passed to the storage backend

Allowed from any attachment status. Always resets the attachment to `pending_storage` and starts a fresh ingestion task.

Returns `202 Accepted` with the updated attachment resource once the external ingestion task has been started.

## Storage Model

The attachment record is canonical ledger state. The binary file is not stored by family-ledger itself.

The implementation stores backend-specific operational state including the storage backend identifier, ingestion task handle, polling timestamps, and timeout deadline. These are surfaced in read-only form through `storage_metadata` (see Public Contract above). The storage backend identifier itself is not exposed.

## Status Model

Attachment status values:

| Status | Meaning |
|---|---|
| `pending_upload` | Record created; no file has been uploaded yet |
| `pending_storage` | File accepted by the external backend; ingestion in progress |
| `stored` | Ingestion completed; `document_url` is available |
| `failed` | External backend reported terminal failure |
| `timed_out` | Ingestion did not reach a terminal state before the configured deadline |

Status transitions:

```
pending_upload  ──:upload──▶  pending_storage  ──▶  stored
                                                └──▶  failed
                                                └──▶  timed_out

stored / failed / timed_out  ──:upload──▶  pending_storage  (re-upload from any status)
```

If the external backend reports that the uploaded file matches an already-existing document, the attachment still resolves to `stored` and may share the same `document_url` as another attachment.

## Deduplication

The unique key for attachments is `(account, original_filename, attachment_date)`.

Attempting to create a second attachment with the same key returns `409 Conflict`. This is the same behaviour as all other create endpoints in the API (see [backend-api.md](backend-api.md)).

The `:upload` method is intentionally separate from create: it can be called on an existing record to retry a failed or timed-out upload without creating a duplicate.

## Paperless-ngx Integration

Current Paperless endpoints used:

- `POST /api/documents/post_document/`
- `GET /api/tasks/?task_id=<uuid>`

Upload is authenticated with:

- `Authorization: Token <token>`
- `Accept: application/json; version=10`

`POST /api/documents/post_document/` accepts multipart form data with required field `document` and returns a task UUID string.

The backend then polls `GET /api/tasks/?task_id=<uuid>` until the task reaches a terminal state.

Success mapping:

- `result_data.document_id` → final document id
- `result_data.duplicate_of` → use the existing Paperless document id; configured tags are applied to that document

The final `document_url` is derived from the resulting Paperless document resource and uses the web UI path format: `{base_url}/documents/{id}` (no `/api/` prefix, no trailing slash). If `FAMILY_LEDGER_PAPERLESS_EXTERNAL_BASE_URL` is set, it is used as the base instead of `FAMILY_LEDGER_PAPERLESS_BASE_URL`. This allows linking to an externally-accessible URL (e.g. a Tailscale hostname) while the API communicates with Paperless on an internal address.

## Background Processing

Attachment ingestion completion is handled by a backend poller started with the application.

The poller:

- periodically scans attachments in `pending_storage`
- checks whether their storage deadline has elapsed
- polls the external backend for task status
- updates attachment status and final `document_url` when ingestion completes

Attachments in `pending_upload` are not polled.

Doctor does not call the external storage backend directly. It only reports attachment issues from persisted backend state.

## Diagnostics

`POST /ledger:doctor` reports these attachment issue families:

- `attachment_pending_upload`: attachment has no file uploaded yet
- `attachment_storage_failed`: external backend reported a terminal failure
- `attachment_storage_timed_out`: ingestion did not complete before the deadline

All three are reported immediately with no age threshold.

## Why It Works This Way

Separating `POST /attachments` (metadata create) from `POST /attachments/{name}:upload` (file transfer) keeps the create endpoint consistent with all other entities in the API: JSON body, `201 Created`, `409` on duplicate. The async file upload lifecycle is isolated to the `:upload` custom method (AIP-136 pattern).

This design keeps the ledger-facing attachment model small while allowing asynchronous document ingestion through a specialized backend.

It deliberately separates:

- canonical ledger attachment identity
- final externally accessible document reference
- backend-specific operational state

That keeps the API stable even if the underlying document backend changes later.
