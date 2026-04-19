# ADR 0001: Canonical Source Of Truth

## Status

Accepted

## Context

The existing workflow uses a Beancount ledger file as the operational source of truth, plus helper scripts and read-only tooling.

That workflow is simple, but it creates several structural problems for the new system:
- poor concurrent write behavior
- weak fit for API-first writes
- awkward lifecycle for imports and partial automation
- pressure to model runtime state around file layout instead of domain semantics

At the same time, Beancount compatibility remains valuable because the existing workflow and downstream tools rely on it.

## Decision

Use PostgreSQL as the canonical source of truth for ledger state.

Use Beancount as:
- an export format
- an interoperability format
- a validation/comparison target where useful

Do not use Beancount files as the runtime storage model.

## Consequences

Positive:
- API writes can target canonical DB state directly.
- Concurrent use is handled by the database instead of file coordination.
- Imports, edits, and future automation are easier to model around domain data.
- Beancount compatibility can be preserved through deterministic export rather than file-native mutation.

Negative:
- The project must define and maintain its own canonical schema.
- Export behavior becomes critical because the file is no longer the primary store.
- Some Beancount concepts need deliberate translation into DB-native structures rather than being inherited mechanically.
