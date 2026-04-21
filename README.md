# family-ledger

[![CI](https://github.com/fterrier/family-ledger/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fterrier/family-ledger/actions/workflows/ci.yml)

DB-backed, API-first family accounting platform with Beancount-compatible export.

## Status

Phase 1 scaffold:
- FastAPI app with `GET /healthz`
- PostgreSQL via Docker Compose
- startup fails fast if config is invalid or the database is unavailable
- Alembic initialized for future schema migrations

## Docker Deployment

1. Copy `docker/compose/.env.example` to `docker/compose/.env`.

```bash
cp docker/compose/.env.example docker/compose/.env
```

2. Edit `docker/compose/.env` and set a real `POSTGRES_PASSWORD`.
   Also set a real `FAMILY_LEDGER_API_TOKEN`.

   `docker/compose/.env.example` is the checked-in template.
   `docker/compose/.env` is your local deployment file and should not be committed.

3. Start the stack:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env up -d
```

4. Run migrations:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env exec api alembic upgrade head
```

5. Check the app health endpoint:

```bash
curl http://localhost:8000/healthz
```

All ledger API routes except `GET /healthz` require `Authorization: Bearer <token>`.

### Ledger Config

The compose file mounts `./config/ledger.yaml` into the container at `/app/config/ledger.yaml` by default.

For the standard deployment flow, just edit `docker/compose/config/ledger.yaml` and restart the stack.

If you want a different location, you can still override `FAMILY_LEDGER_LEDGER_CONFIG_PATH` and the bind mount yourself.

## Synology

The same Docker flow works on Synology Container Manager.

Recommended setup:
- create a persistent deployment folder on the NAS
- copy these files into it:
  - `docker/compose/docker-compose.yml`
  - `docker/compose/.env.example` (rename it to `.env`)
  - `docker/compose/config/ledger.yaml`
- edit `.env` and `config/ledger.yaml` in that folder
- run the same compose and migration commands shown above from that folder

## Updating

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env pull
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env up -d
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env exec api alembic upgrade head
```

## Google Sheets Access

Google Apps Script runs on Google's servers. It cannot call `localhost`, a private LAN IP, or a plain private Tailscale address.

For the Google Sheets client, the API must be reachable over public HTTPS.

Recommended setup:
- run `family-ledger` on-prem
- expose it with `Tailscale Funnel`
- set a strong `FAMILY_LEDGER_API_TOKEN`
- configure the same base URL and token in the Sheets client

`GET /healthz` stays open for reachability checks. Ledger routes still require the bearer token.

## Troubleshooting

Check service status:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env ps
```

Check logs:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env logs
```

Stop the stack:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env down
```

Remove all local PostgreSQL data:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env down -v
```

## Local Development

For application development, prefer the Python/`uv` workflow rather than Docker image rebuilding:

- use `uv` locally
- run tests locally
- use Docker primarily for deployment verification

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `family_ledger` | PostgreSQL database name |
| `POSTGRES_USER` | `family_ledger` | PostgreSQL username |
| `POSTGRES_PASSWORD` | - | **Required**. Set in `.env` |
| `FAMILY_LEDGER_API_TOKEN` | - | **Required**. Bearer token for all ledger API routes |
| `FAMILY_LEDGER_IMAGE` | `ghcr.io/fterrier/family-ledger:latest` | Container image to run |
| `FAMILY_LEDGER_DATABASE_URL` | `postgresql+psycopg://...` | Database connection URL |
| `FAMILY_LEDGER_LEDGER_CONFIG_PATH` | `/app/config/ledger.yaml` | Path to the mounted ledger config inside the container |

`docker/compose/.env.example` is the checked-in example. Copy it to `docker/compose/.env`
for a real deployment.

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

## Demo Data

You can bootstrap a small example ledger into an empty database for local testing.

Local Python environment:

```bash
uv run python scripts/bootstrap_demo.py
```

Docker deployment:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env exec api python scripts/bootstrap_demo.py
```

The script is intentionally separate from the runtime app code path and will refuse to run if the
database already contains ledger data.

## Config

The app expects a YAML ledger config file. For Docker deployments, the compose setup mounts
`docker/compose/config/ledger.yaml` into the container at `/app/config/ledger.yaml` by default.

There are only two checked-in config files now:
- `config/ledger.yaml`: canonical default config used for local app startup and baked into the image
- `docker/compose/config/ledger.yaml`: deployment copy intended to be edited for Docker installs

## Docs

- `docs/compatibility-target-v0.1.md`
- `docs/domain-model-v0.1.md`
- `docs/api-v0.1.md`
- `docs/beancount-import-bootstrap-v0.1.md`
- `docs/adr/`
- `docs/requirements-v0.1.md`
- `docs/roadmap-v0.1.md`
- `docs/developer-guidelines-v0.1.md`

## Clients

- `clients/google-sheets/`: narrow Google Sheets POC for category edits and split updates via the API
