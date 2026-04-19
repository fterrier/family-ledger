# family-ledger

[![CI](https://github.com/fterrier/family-ledger/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fterrier/family-ledger/actions/workflows/ci.yml)
[![pre-commit.ci status](https://results.pre-commit.ci/badge/github/fterrier/family-ledger/main.svg)](https://results.pre-commit.ci/latest/github/fterrier/family-ledger/main)

DB-backed, API-first family accounting platform with Beancount-compatible export.

## Status

Phase 1 scaffold:
- FastAPI app with `GET /healthz`
- PostgreSQL via Docker Compose
- startup fails fast if config is invalid or the database is unavailable
- Alembic initialized for future schema migrations

## Quick Start

1. Copy `.env.example` to `.env` if you want to override defaults.
2. Start the stack:

```bash
docker compose up --build
```

3. Check the app health endpoint:

```bash
curl http://localhost:8000/healthz
```

## Tests

Run tests locally:

```bash
uv venv
uv pip install --python .venv/bin/python -e .[dev]
uv run pytest
```

Install the local git hooks:

```bash
uv run pre-commit install
```

## Migrations

Run Alembic from the app environment:

```bash
alembic upgrade head
```

The project includes an initial Alembic schema migration for the core ledger tables.

## Config

The app expects a YAML ledger config file. A default local example is checked in at `config/ledger.yaml`.

## Docs

- `docs/compatibility-target-v0.1.md`
- `docs/domain-model-v0.1.md`
- `docs/api-v0.1.md`
- `docs/adr/`
- `docs/requirements-v0.1.md`
- `docs/roadmap-v0.1.md`
- `docs/developer-guidelines-v0.1.md`
