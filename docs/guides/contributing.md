# Contributing

## Default Approach

- prefer the smallest correct change
- preserve the database as the source of truth
- keep specs aligned with implemented behavior
- keep Beancount compatibility focused on semantics, not file-editing mechanics

## Documentation Rules

- update `docs/specs/` when behavior or contracts change
- update `docs/guides/` when maintenance workflow changes
- add or update ADRs for major structural decisions
- avoid creating multiple active documents for the same truth
- move superseded planning or design material to `archive/docs/`

## Before Changing Code

- read the relevant spec in `docs/specs/`
- read the relevant ADRs if the change touches a structural decision
- inspect the actual code path before editing; do not infer models or payloads from stale docs

## Testing Expectations

- every implemented behavior should have focused unit test coverage
- prefer unit tests by default; use broader integration tests only when the behavior cannot be validated well in isolation
- for bug fixes, prefer adding a failing regression test first, then implement the fix
- a change is only complete when the new test passes and the relevant existing tests still pass

## Project Boundaries

- the API is canonical
- Google Sheets is a constrained client, not source of truth
- importer config is sparse and schema-validated
- attachment records are canonical ledger state, but binary storage is delegated to an external document backend
