# Family Accounting Platform Roadmap v0.1

## Purpose
Describe the implementation order and lock in the first version scope.

## Version 1 Goal
Deliver a DB-backed, API-first ledger that can replace the current Beancount-based workflow for day-to-day accounting data entry and validation.

Version 1 must provide:
- an API that correctly replicates the necessary ledger functionality for the existing Beancount data
- transaction and posting support close to Beancount semantics
- balance checking and balance assertions
- deterministic full-ledger Beancount export for read-only Fava usage
- spreadsheet integration through the API for editing transaction categories
- Docker Compose deployment on a Synology host

## Start Here
Phase 1 is the first implementation target.

The goal of Phase 1 is to make the project runnable end-to-end before the full ledger API exists.

Phase 1 should deliver:
- Docker Compose service packaging
- a working Synology-compatible deployment path
- a minimal app skeleton with health/readiness endpoints
- test execution in the containerized environment
- placeholder API responses such as `Not implemented` where needed
- startup/shutdown/backup notes for self-hosting

## Version 1 Scope
### Must Have
- accounts, transactions, postings, commodities, prices
- multi-currency support
- lot/cost support for current investment use cases
- strict transaction balance verification
- balance assertions with project-level tolerance rules
- deduplication by native ID or fingerprint
- deterministic full-ledger Beancount export
- read-only Fava workflow from exported Beancount
- Google Sheets integration for category edits via API
- Docker Compose deployment

### Must Not Have
- dedicated UI
- native mobile apps
- period locking
- full reconciliation engine
- event sourcing
- CQRS
- microservices
- spreadsheet as source of truth
- automatic `pad` generation

## Delivery Phases

### Phase 0: Requirements, Compatibility, and Model
- finalize requirements
- finalize compatibility target
- finalize domain model
- finalize API contract
- finalize developer guidelines
- confirm the minimum Beancount compatibility target

### Phase 1: Deployment Scaffold
- package the service for Docker Compose
- make the stack runnable on Synology very early
- allow tests to run even when some APIs return `Not implemented`
- document startup, shutdown, and backup basics

### Phase 2: Ledger Core
- implement the DB schema
- implement transaction and posting writes
- implement balance checks
- implement balance assertions
- implement project-level precision/tolerance config

### Phase 3: Imports
- implement native ID dedupe
- implement fingerprint dedupe
- implement direct-to-transaction import behavior
- keep import behavior create-or-skip with no overwrite path in v1

### Phase 4: Beancount Export
- export deterministic full-ledger Beancount
- verify export against the existing ledger semantics
- use exported files with Fava in read-only mode

### Phase 5: Spreadsheet Integration
- expose category-editing workflows through the API
- connect Google Sheets as a client of the same API

## Notes
- Fava is read-only in v1; changes made there do not sync back to the database.
- Google Sheets is a planned client workflow for categorization in v1, not the source of truth.
- Transactions remain editable in v1; locking and audit history are deferred.
- Unbalanced transactions remain part of the ledger and may still be exported in v1.
- The implementation should remain a modular monolith.
