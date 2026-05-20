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

The API does not expose backend-specific lifecycle metadata such as task identifiers, polling timestamps, or raw provider errors.

## Current API Shape

- `GET /attachments`
- `POST /attachments`
- `GET /attachments/{attachment}`

`POST /attachments` requires:

- `file`
- `account`
- `attachment_date`

Optional fields:

- `title`
- `entity_metadata`

The route returns `202 Accepted` once the external storage backend has accepted the upload and returned a task handle.

## Storage Model

The attachment record is canonical ledger state. The binary file is not stored by family-ledger itself.

The implementation stores backend-specific operational state internally, including:

- storage backend identifier
- external ingestion task handle
- polling timestamps
- timeout deadline
- final backend document identifier
- backend error details

Those fields are internal implementation detail and are not part of the public resource contract.

## Status Model

Attachment status values are:

- `pending_storage`
- `stored`
- `failed`
- `timed_out`

Status semantics:

- `pending_storage`: the external backend accepted the upload and ingestion is still in progress
- `stored`: ingestion completed successfully and `document_url` is available
- `failed`: the external backend reported terminal failure
- `timed_out`: ingestion did not reach a terminal success state before the configured deadline

If the external backend reports that the uploaded file matches an already-existing document, the attachment still resolves to `stored` and may share the same `document_url` as another attachment.

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

- `result_data.document_id` -> final document id
- `result_data.duplicate_of` -> use the existing Paperless document id

The final `document_url` is derived from the resulting Paperless document resource.

## Background Processing

Attachment ingestion completion is handled by a backend poller started with the application.

The poller:

- periodically scans attachments in `pending_storage`
- checks whether their storage deadline has elapsed
- polls the external backend for task status
- updates attachment status and final `document_url` when ingestion completes

Doctor does not call the external storage backend directly. It only reports attachment issues from persisted backend state.

## Diagnostics

`POST /ledger:doctor` reports these attachment issue families:

- `attachment_storage_failed`
- `attachment_storage_timed_out`

These are derived operational diagnostics rather than canonical attachment fields.

## Why It Works This Way

This design keeps the ledger-facing attachment model small while allowing asynchronous document ingestion through a specialized backend.

It deliberately separates:

- canonical ledger attachment identity
- final externally accessible document reference
- backend-specific operational state

That keeps the API stable even if the underlying document backend changes later.
