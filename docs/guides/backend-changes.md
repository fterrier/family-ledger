# Backend Changes

Use this checklist when changing backend behavior.

## If You Change Models

- update SQLAlchemy models under `src/family_ledger/models/`
- add or update Alembic migrations
- update `docs/specs/domain-model.md` if the canonical model changed

## If You Change API Behavior

- update request or response schemas in `src/family_ledger/api/schemas.py`
- update routes under `src/family_ledger/api/`
- update `docs/specs/backend-api.md`
- update related tests

## If You Change Ledger Semantics

- inspect the relevant service under `src/family_ledger/services/`
- update the relevant spec, especially `product-scope.md`, `domain-model.md`, or `account-balance-and-pad.md`
- update ADRs if the change revisits a structural decision

## If You Change Importer Behavior

- update `docs/specs/import-system.md`
- verify importer tests and API tests together
