# Family Accounting Platform Developer Guidelines v0.1

## Purpose
These guidelines are for developers and coding agents working on the family accounting platform.

The priorities are:
- simplicity
- correctness
- maintainability
- Beancount semantic compatibility

## Core Engineering Principles
- Keep the system close to Beancount concepts: transactions, postings, accounts, commodities, prices.
- Prefer the smallest correct change.
- Avoid inventing new abstractions without a second real use case.
- Keep the database as the source of truth.
- Keep Beancount export deterministic.
- Keep the first version boring.

## Documentation and Attribution
- Document the project to the standard expected of a mature open source project.
- Link and quote external sources when they materially influence the design.
- Do not leave inspiration, dependency, or comparison claims unreferenced in the docs.
- Prefer concise but complete documentation over informal notes.

## Architecture Defaults
- Modular monolith
- PostgreSQL as the source of truth
- DB-native ledger, not file-native
- import pipeline built around `import_jobs` and `import_items`
- deterministic Beancount export as the interoperability layer
- no dedicated UI in v1
- Google Sheets only as a controlled client on top of the API
- Fava is read-only and must not write back to the DB

## Recommended Stack
- Backend: Python
- API: FastAPI
- Database: PostgreSQL
- Persistence: SQLAlchemy
- Tests: pytest
- Deployment: Docker Compose on a single self-hosted node
- Frontend: defer for now; do not lock a stack prematurely

## Beancount Reuse Policy
Where practical, reuse Beancount code or logic for pure ledger-validation tasks.

Good reuse targets:
- transaction balance verification
- balance assertion verification
- tolerance and precision behavior
- exported ledger validity checks

Rules:
- reuse Beancount semantics when it reduces risk
- do not shape the application data model around Beancount internals
- do not make Beancount the runtime source of truth
- the database remains canonical; Beancount is a validation aid and export target

If Beancount logic is used, it should be through a clean boundary that does not couple the app too tightly to its file-based workflow.

## Testing Policy

### Unit Tests
Use unit tests by default.

Unit tests should cover:
- transaction balancing logic
- posting and account invariants
- import fingerprinting and dedupe helpers
- balance assertion rules
- export formatting helpers

### Integration Tests
Keep integration tests to a minimum.

Only add integration tests for critical user journeys that unit tests cannot cover well.

### Critical Integration Journeys
- import with native ID deduplication
- import with fingerprint fallback deduplication
- create a balanced transaction
- reject an unbalanced transaction
- security buy/sell with lot tracking and realized gain/loss
- balance assertion validation using project-level tolerance
- deterministic Beancount export
- one realistic concurrent workflow test

### Beancount as Test Oracle
If Beancount validation can be called safely, use it as an oracle for selected cases:
- balance checking
- tolerance edge cases
- assertion behavior
- exported ledger validity

## Deployment Guidance
- Start with Docker Compose
- Prefer a modular monolith over services
- Avoid Kubernetes and microservices in v1
- Avoid queues unless imports or background tasks clearly require them
- Keep project-level settings in files, not the database

## Import Guidance
- Keep imports synchronous unless they become too slow for the request path.
- Use native source IDs when available.
- Fall back to fingerprints when native IDs are unavailable.
- Keep import review simple and close to the ledger model.

## Developer Rules
- Preserve the transaction/posting model.
- Keep investment events as normal postings inside transactions.
- Keep import tracking simple: `import_jobs` and `import_items`.
- Use deterministic export output.
- Prefer explicit validations over hidden magic.
- Do not add a plugin system unless multiple concrete plugins already exist.
- Do not add reconciliation workflows beyond lightweight balance verification in v1.

## Anti-Goals
- no CQRS
- no event sourcing
- no microservices
- no native mobile app in v1
- no full reconciliation engine in v1
- no special investment event hierarchy in v1
- no spreadsheet as source of truth

## Notes for Agents
- Read the requirements doc before changing code.
- Keep changes scoped and aligned with the existing accounting model.
- If a change affects validation, add tests first or alongside the change.
- If a change affects Beancount export, add deterministic export tests.
- If a change touches imports, verify dedupe behavior explicitly.
