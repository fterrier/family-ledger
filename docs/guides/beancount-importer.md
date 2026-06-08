# Beancount Importer

The Beancount importer migrates an existing `.beancount` ledger file into family-ledger. It is the primary path for initial data migration.

## Supported Directives

| Directive | Imported as |
|---|---|
| `open` | Account (effective_start_date from the directive date) |
| `close` | Account effective_end_date |
| `commodity` | Commodity |
| `txn` / `*` / `!` | Transaction with postings |
| `price` | Price |
| `balance` | BalanceAssertion |
| `pad` | Skipped — pad directives are synthetic; run `GET /accounts/{account}:pad` instead |
| `document` | Attachment record (see below) |
| `note` | Skipped |
| `custom` | Skipped |

## Configuration

Set via `Importer Settings` in Sheets or `PATCH /importers/{importer}`:

| Field | Type | Default | Description |
|---|---|---------|-------------|
| `posting_comment` | boolean | `false` | Import trailing posting comments (e.g. `; my note`) as per-posting `narration` fields |

## File Inputs

| Input | Required | Accepted formats |
|---|---|---|
| Ledger file | Yes | `.beancount` |
| Documents archive | No | `.zip` |

## Document Directives

`document` directives are imported as `stored` attachment records.

If the directive's `document_url` metadata is set (e.g. `document_url: "http://paperless/documents/42"`), it is used directly and the attachment is linked to that Paperless document.

If there is no `document_url`, the importer looks for a file matching the directive's filename (basename only) inside the documents ZIP archive. If found and Paperless is configured, the file is uploaded to Paperless and the attachment transitions to `pending_storage`. Documents with neither a URL nor a matching ZIP entry are skipped with a warning.

## Metadata Round-trip

Transaction metadata keys stored under `entity_metadata["beancount"]` are emitted back as Beancount metadata on `export-beancount`. This preserves Beancount-specific keys (e.g. `document_url`, `lineno`) through an import-then-export cycle.

## Deduplication

Transactions are deduplicated by `source_native_id`, which is set to the transaction's file line number (e.g. `"beancount:line:142"`). Re-running the same import skips already-imported transactions.

## Running the Import

From the Google Sheets `Import data` dialog, select the Beancount importer, upload your `.beancount` file (and optionally a `.zip` of documents), and run.

For large ledgers, run from the CLI:

```bash
docker compose -f docker/compose/docker-compose.yml exec api \
  python -c "..."  # use the API directly via curl
```

Or via the API:

```bash
curl -X POST https://your-ledger/importers/importers%2Fbeancount:import \
  -H "Authorization: Bearer $TOKEN" \
  -F "ledger_file=@ledger.beancount" \
  -F "documents_file=@documents.zip"
```
