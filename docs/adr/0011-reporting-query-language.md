# 0011 — Reporting Via A BQL-Subset Query Endpoint

## Status

Accepted (2026-07-06).

## Context

The mobile account detail screen needs balance-over-time series and per-month
totals. The backend had no reporting endpoint; the alternatives were bespoke
endpoints per chart (`:balanceSeries`, `:monthlyTotals`, …) or one flexible
read-only query surface.

## Decision

One endpoint, `POST /ledger:query`, accepting a subset of the Beancount Query
Language (BQL). The server lexes and parses the query into an AST, validates
every identifier and function against a whitelist, compiles to SQLAlchemy
Core selects (doctor-style column tuples, no ORM hydration), and
post-processes in Python (currency folding, running-balance accumulation,
price conversion).

Key choices:

- **BQL, not a homegrown dialect**: semantics are documented elsewhere,
  queries are portable against the Beancount export, and parity is testable
  with `beanquery` (see `tests/integration/test_query_parity.py`).
- **Injection safety by construction**: closed grammar, identifier
  whitelists, and bound parameters everywhere — user text never becomes SQL
  text (see `tests/test_services_query_injection.py`).
- **Running balance in the executor, not SQL**: `last(balance)` compiles to
  the same per-bucket sums as `sum(position)`; the executor accumulates on
  top of an `OPEN ON` seed query. This keeps the SQL portable across SQLite
  and Postgres and matches BQL's summarization semantics.
- **Documented deviations** (bucket-end `convert()` dates, `last(balance)`
  in grouped queries) are listed in the spec's deviation table.

## Consequences

- New reports (net worth, category breakdowns) are new queries, not new
  endpoints; the Sheets client can reuse the same surface.
- The language can grow toward fuller BQL (ORDER BY, tags, FROM expressions)
  without breaking clients.
- The executor owns conversion/accumulation semantics, so SQL stays simple;
  heavy result sets are bounded by query-length and row caps.

See `docs/specs/reporting-query.md` for the full contract.
