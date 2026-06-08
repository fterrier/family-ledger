# Viseca One Card Importer

The Viseca importer imports monthly credit card statements from Viseca One Card (the card management platform used by many Swiss cantonal banks and Raiffeisen).

## Getting the File

1. Log in to [one.viseca.ch](https://one.viseca.ch)
2. Navigate to **Documents** → **Invoices**
3. Download the monthly statement PDF

The importer detects the statement date from the filename (pattern `*_YYYYMMDD_*.pdf`). If the date cannot be parsed from the filename, today's date is used.

## Configuration

Set via `Importer Settings` in Sheets or `PATCH /importers/{importer}`:

| Field | Type | Default | Description |
|---|---|---------|-------------|
| `cards` | object | `{}` | Map of card last-4 digits → ledger account resource name |

The `cards` map is required. The importer identifies card sections in the PDF by the last 4 digits of each card number. If a card appears in the statement but is not in the config, the import fails with an `unknown_card` error.

Example config:

```json
{
  "cards": {
    "1234": "accounts/acc_abc123",
    "5678": "accounts/acc_def456"
  }
}
```

To find the last-4 digits: they appear on the physical card and in the PDF statement header for each card section.

## What Gets Imported

- One transaction per line item, posted to the configured card account
- A CHF balance assertion per card at the statement close date (using the "Total carte" amount)
- Preamble entries (e.g. payments to Viseca) are posted to the first card's account

## Attachment Upload

If Paperless-ngx is configured, the statement PDF is uploaded as an attachment linked to the first card's account.

## Deduplication

Transactions are deduplicated by `source_native_id`, derived from the statement date and line item position. Re-importing the same statement skips already-imported entries.
