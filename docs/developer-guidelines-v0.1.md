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
- Treat `docs/compatibility-target-v0.1.md` as a primary design constraint when making implementation decisions.
- After editing any design or architecture doc, review the related requirements, domain model, API docs, ADRs, and README to make sure they remain consistent, non-contradictory, and complementary.
- Client-specific documentation should live with the client under its own directory whenever practical.
- Keep top-level docs focused on shared product, API, domain, and deployment concerns.
- Do not replicate detailed client usage or design documentation across the repo; link to the client-local docs instead.

## ADRs
- Add an ADR for architectural decisions that are structural, non-obvious, costly to reverse, or likely to be revisited.
- Prefer ADRs for decisions about canonical storage, API identity, validation boundaries, import model, and other system-wide design choices.
- Do not add ADRs for minor field names, small endpoint details, examples, or other decisions that are easy to infer from the current docs or code.
- ADRs should explain why a decision was made; the requirements, domain model, and API docs remain the source of truth for exact behavior.
- Keep ADRs short and update or supersede them when a recorded decision changes.

## README Expectations
- The `README.md` should help a human quickly understand what the project is, what functionality it offers, and why it exists.
- The `README.md` should include installation and startup instructions.
- The `README.md` should explain the main workflows at a high level.
- The `README.md` should be maintained as a first-class project document, not an afterthought.

## Architecture Defaults
- Modular monolith
- PostgreSQL as the source of truth
- DB-native ledger, not file-native
- import metadata stored directly on transactions
- deterministic Beancount export as the interoperability layer
- no dedicated UI in v1
- Google Sheets as one possible client on top of the API
- Fava is read-only and must not write back to the DB

## Compatibility Defaults
- Model account `open` and `close` semantics as effective-date fields on accounts.
- Reject transactions that reference accounts outside their effective date range.
- Model document-style references as attachments in the canonical data model.
- Preserve strict cost-based lot matching for supported investment disposals.
- Support deterministic full-ledger export only in v1.
- Keep uncategorized placeholder account names in config, not on account rows.

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

## Mutability and Controls
- In v1, transactions remain editable.
- Do not add field-level locking or restricted-edit infrastructure in v1 unless requirements change.
- Client applications may expose narrower editing workflows, but the API is not required to enforce them in v1.
- Audit history and change logging are deferred beyond v1.

## Import Guidance
- Keep imports synchronous unless they become too slow for the request path.
- Use native source IDs when available.
- Fall back to fingerprints when native IDs are unavailable.
- Keep import handling close to the transaction/posting model; do not add staged import abstractions without a concrete need.
- Keep imports create-or-skip in v1; do not add overwrite behavior without an explicit design change.

## Developer Rules
- Preserve the transaction/posting model.
- Keep investment events as normal postings inside transactions.
- Keep transaction dedupe metadata minimal: source native ID and fingerprint.
- Consider adherence to relevant `aip.dev` guidance by default when modifying API resources, methods, or payload shapes.
- Consider relevant `aip.dev` guidance for response codes as well; invalid references and request-state problems should not default to `404` just because a named dependency is missing from the request body.
- Keep `update_mask` in the API contract for AIP consistency even if v1 implementations initially ignore it.
- Use deterministic export output.
- Do not assume FIFO is sufficient for security disposals; preserve strict cost-based matching.
- Prefer explicit validations over hidden magic.
- Keep HTTP concerns out of services; service modules should raise domain exceptions and let the API layer translate them into response codes and payloads.
- When normalization and persistence differ, document the boundary explicitly and keep normalization out of canonical persistence endpoints unless that behavior is an intentional API contract decision.
- If a normalize-style endpoint and a persistence endpoint accept the same input shape, they should share one normalization/validation implementation rather than duplicating rules.
- When a file starts mixing route wiring, request/response schemas, validation, serialization, and persistence logic, split it into smaller modules rather than growing one large API file.
- Keep a service layer only when it supports meaningful tests that are not duplicates of route-level API tests.
- Good service tests cover business logic such as fingerprinting, resolution, validation, serialization, and persistence behavior.
- If service tests mostly repeat route tests without adding value, prefer collapsing overly thin service code back into the API module.
- Split service modules by entity or aggregate boundary only when the resulting tests and navigation become clearer than the combined service file.
- On read paths, avoid N+1 query patterns for related resources. Prefer bounded batched queries keyed by indexed columns, or indexed eager loading, over per-entity follow-up queries.
- For paginated one-to-many reads, page the parent resources first and then load related rows for just that page in a bounded number of queries.
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
- Read `docs/domain-model-v0.1.md` before changing schema or persistence behavior.
- Read `docs/api-v0.1.md` before changing endpoint behavior or response shapes.
- Read the relevant ADRs before revisiting a major architectural decision.
- Keep changes scoped and aligned with the existing accounting model.
- If a change affects validation, add tests first or alongside the change.
- If a change affects Beancount export, add deterministic export tests.
- If a change touches imports, verify dedupe behavior explicitly.
- For Google Sheets and Apps Script clients, optimize hot-path actions for large sheets (thousands of rows). Only full sync/rebuild actions should rewrite the entire sheet; edit-driven and active-row actions should locate the relevant transaction group and update only the affected rows and columns.
