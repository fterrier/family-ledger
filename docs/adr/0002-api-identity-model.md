# ADR 0002: API Identity Model

## Status

Accepted

## Context

The API needs stable resource identity while also preserving ledger-oriented naming and export semantics.

For accounts in particular, the Beancount hierarchy name should be editable without forcing historical postings to be rewritten. At the same time, the API should stay close to resource-oriented design guidance from `aip.dev` where practical.

There is also a domain-specific distinction between:
- references to resources such as accounts
- ledger value objects such as `CHF`, `USD`, and `GOOG`

Those should not be forced into the same identifier model.

## Decision

Use stable resource `name` fields as the canonical external identity for API resources.

For accounts, keep a separate mutable `ledger_name` field for the Beancount-compatible hierarchy name.

For money-like value objects, keep raw ledger symbols in `symbol` fields rather than using commodity resource names.

Follow relevant `aip.dev` guidance by default for resource naming and method structure, with explicit ledger-specific deviations where needed.

## Consequences

Positive:
- Account renames do not require rewriting postings.
- The API remains closer to established resource-oriented conventions.
- Ledger payloads stay readable and natural for imports and spreadsheet-style clients.
- Commodity resources can still exist without forcing resource names into every money-like field.

Negative:
- The model intentionally mixes AIP-style resource names for references with raw ledger symbols for value objects.
- The API must clearly document the distinction between stable resource identity and mutable ledger-facing names.
