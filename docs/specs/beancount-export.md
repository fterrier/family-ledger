# Beancount Export

## Purpose

The `export-beancount` CLI produces a single `.beancount` file that is a complete, self-consistent snapshot of the ledger at the time of export. The file is suitable for `bean-check` validation and as the data source for Fava.

## CLI Interface

```
export-beancount [--output FILE] [--documents-dir DIR] [--force-download]
```

| Flag | Default | Meaning |
|---|---|---|
| `--output FILE` | stdout | Write the Beancount file to `FILE` instead of stdout |
| `--documents-dir DIR` | none | Download stored attachments from Paperless-ngx into `DIR`; emit `option "documents"` pointing to `DIR` |
| `--force-download` | false | Re-download files even when they already exist in `--documents-dir` |

When `--documents-dir` is set, the `option "documents"` directive uses the absolute path to `DIR` so that `bean-check` and Fava can resolve document links regardless of where the `.beancount` file is located.

Download failures are logged as warnings and do not abort the export — the `.beancount` file is always produced.

## Output Format

The export produces one file with sections separated by blank lines, in this order:

### 1. Options

```beancount
option "operating_currency" "CHF"
option "inferred_tolerance_default" "CHF:0.005"
option "inferred_tolerance_default" "USD:0.005"
```

`operating_currency` comes from `ledger.yaml → default_currency`.

Per-currency `inferred_tolerance_default` entries come from `ledger.yaml → tolerance`. One entry is emitted per configured symbol, in alphabetical order.

When `--documents-dir` is set, an additional `option "documents"` line is emitted here.

### 2. Commodities

```beancount
2000-01-01 commodity CHF
2000-01-01 commodity USD
```

All commodities are emitted with a fixed date of `2000-01-01`, ordered by symbol.

### 3. Accounts (open and close directives)

```beancount
2024-01-01 open Assets:Bank:Checking
2024-01-01 open Expenses:Food
2025-06-01 close Assets:Bank:OldAccount
```

Open directives use `account.effective_start_date`, ordered by start date then account name.
Close directives (for accounts with `effective_end_date`) are appended in the same section, ordered by end date then account name.

### 4. Prices

```beancount
2026-01-15 price VTI 215.30 USD
```

Ordered by price date then base symbol.

### 5. Transactions

```beancount
2026-03-01 * "Grocery Store" "Weekly shopping"
  source_native_id: "import-abc-123"
  Assets:Bank:Checking  -84.25 CHF
  Expenses:Food          84.25 CHF

2026-03-02 * "Buy VTI"
  Assets:Investments:VTI   5 VTI {215.00 CHF}
  Assets:Bank:Checking  -1075.00 CHF
```

Ordered by transaction date then name (the opaque resource name, for stable ordering).

**Metadata round-trip:** Keys from `entity_metadata` that match `[a-z][a-z0-9_]*` are emitted as transaction-level metadata. Keys nested under `entity_metadata["beancount"]` are merged on top, with `beancount`-keyed values winning on conflicts. This allows Beancount-specific metadata to be preserved through an import-then-export cycle.

`source_native_id` is always emitted when present.

**Cost and price annotations:**
- A posting with `cost_per_unit` produces `{cost_per_unit cost_symbol}` (lot cost)
- A posting with `price_per_unit` produces `@ price_per_unit price_symbol` (conversion price)
- Per-posting `narration` is emitted as an inline comment: `  Account  amount ; narration`

Transactions are double-spaced (one blank line between each).

### 6. Balance Assertions

```beancount
2026-03-31 balance Assets:Bank:Checking  1234.56 CHF
```

Ordered by assertion date then name.

### 7. Document Directives

```beancount
2026-03-01 document Assets:Bank:Checking "statement.pdf"
  document_url: "http://paperless.local/documents/2155"
```

Only emitted for attachments with `status = stored`.

Ordered by attachment date then name. Double-spaced like transactions.

The file path is `original_filename` alone when `--documents-dir` is not set; it is `{documents_dir}/{original_filename}` (absolute) when `--documents-dir` is set.

`document_url` and any `entity_metadata` keys matching `[a-z][a-z0-9_]*` (plus keys under `entity_metadata["beancount"]`) are emitted as metadata, with the same merge rule as transactions.

## Documents Download Behaviour

When `--documents-dir` is set, the exporter iterates all `stored` attachments and attempts to download each one from Paperless-ngx using `storage_metadata.document_id`. Attachments without a `document_id` in their storage metadata are skipped silently.

- Files already present in `--documents-dir` are skipped unless `--force-download` is set.
- HTTP failures produce a single summary warning line followed by one detail line per failed attachment; the export continues.

The download uses the internal `FAMILY_LEDGER_PAPERLESS_BASE_URL`, not the stored `document_url`.

## Relation to Fava

The exported file is the primary input to [Fava](https://beancount.github.io/fava/). Run `bean-check ledger.beancount` first to verify there are no structural errors, then `fava ledger.beancount` to browse.
