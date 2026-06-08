# MT940 Importer

The MT940 importer imports bank statements in the SWIFT MT940 format, which is widely supported by Swiss and European banks.

## Getting the File

Most banks offer MT940 export from their e-banking portal under a label such as "Account statement", "Export", or "MT940 / SWIFT". Accepted file extensions: `.sta`, `.txt`, `.mt940`.

Known-working banks: ZKB (Zürcher Kantonalbank), PostFinance, and most other Swiss/EU banks that support SWIFT MT940.

## Configuration

Set via `Importer Settings` in Sheets or `PATCH /importers/{importer}`:

| Field | Type | Default | Description |
|---|---|---------|-------------|
| `account_mappings` | object | `{}` | Map of MT940 `:25:` IBAN values → ledger account resource names (e.g. `"CH12...": "accounts/acc_..."`) |
| `payee_format` | `"generic"` \| `"zkb"` | `"generic"` | Payee formatting style. Use `"zkb"` for ZKB statements which use comma-separated description fields |
| `balance_assertion_frequency` | `"none"` \| `"daily"` \| `"weekly"` \| `"monthly"` | `"none"` | Import MT940 closing balances as balance assertions at the selected frequency |

### Finding IBANs for account_mappings

The `:25:` field in an MT940 file contains the account IBAN. Open the file in a text editor and look for lines starting with `:25:`. Use the full IBAN as the key.

Example config:

```json
{
  "account_mappings": {
    "CH5604835012345678009": "accounts/acc_abc123",
    "CH9300762011623852957": "accounts/acc_def456"
  },
  "payee_format": "zkb",
  "balance_assertion_frequency": "monthly"
}
```

## Deduplication

Transactions are deduplicated by `source_native_id`, derived from the MT940 transaction reference (`:61:` field). Re-importing the same file is safe — already-imported transactions are skipped.

## Validation

If a statement contains IBANs that are not in `account_mappings`, the import fails with a `missing_account_mapping` error listing the unrecognised IBANs. Add them to the config before retrying.
