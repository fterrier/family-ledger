# family-ledger

[![CI](https://github.com/fterrier/family-ledger/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fterrier/family-ledger/actions/workflows/ci.yml)
[![Docker Build](https://github.com/fterrier/family-ledger/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/fterrier/family-ledger/pkgs/container/family-ledger)

DB-backed, API-first family accounting platform with Beancount-compatible export.

## Status

Phase 1 scaffold:
- FastAPI app with `GET /healthz`
- PostgreSQL via Docker Compose
- startup fails fast if config is invalid or the database is unavailable
- Alembic initialized for future schema migrations

## Quick Start (Local Development)

1. Copy the compose files from `docker/compose/` to the project root:

```bash
cp docker/compose/* ./
```

2. Copy `.env.example` to `.env` if you want to override defaults.
3. Start the stack:

   - **Option A - Use pre-built image** (assumes image is published to registry):

     ```bash
     docker compose pull
     docker compose up -d
     ```

   - **Option B - Build locally** (for development with your own changes):

     ```bash
     # Edit docker-compose.yml and change 'image:' to 'build: .'
     docker compose up --build -d
     ```

4. Check the app health endpoint:

```bash
curl http://localhost:8000/healthz
```

## Docker Deployment

For production deployments (e.g., Synology), see [docs/synology-deployment.md](docs/synology-deployment.md) for detailed instructions.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `family_ledger` | PostgreSQL database name |
| `POSTGRES_USER` | `family_ledger` | PostgreSQL username |
| `POSTGRES_PASSWORD` | - | **Required**. Set in `.env` |
| `FAMILY_LEDGER_DATABASE_URL` | `postgresql+psycopg://...` | Database connection URL |
| `FAMILY_LEDGER_LEDGER_CONFIG_PATH` | `/app/config/ledger.yaml` | Path to ledger config |

See `docker/compose/docker-compose.env` for all available options.

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
- `docs/synology-deployment.md`
