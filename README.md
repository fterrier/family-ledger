# family-ledger

[![CI](https://github.com/fterrier/family-ledger/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fterrier/family-ledger/actions/workflows/ci.yml)

DB-backed, API-first family accounting platform with Beancount-compatible export.

## Status

Current implementation includes:
- authenticated FastAPI routes for ledger reads, writes, normalization, diagnostics, and imports, plus open `GET /healthz`
- PostgreSQL persistence with Alembic migrations and Docker Compose deployment
- derived ledger diagnostics through `POST /ledger:doctor`
- on-demand pad computation via `GET /accounts/{account}:pad`
- importer registry and synchronous import execution with idempotent Beancount importer
- account-linked attachments with asynchronous document storage via Paperless-ngx
- `export-beancount` CLI script for full-ledger Beancount export
- Google Sheets client workflow for transaction categorization and editing via the API

## Docker Deployment

1. Copy `docker/compose/.env.example` to `docker/compose/.env`.

```bash
cp docker/compose/.env.example docker/compose/.env
```

2. Edit `docker/compose/.env` and set a real `FAMILY_LEDGER_API_TOKEN`.

   If you want attachment uploads, uncomment and set:

   - `FAMILY_LEDGER_PAPERLESS_BASE_URL`
   - `FAMILY_LEDGER_PAPERLESS_TOKEN`

    `docker/compose/.env.example` is the checked-in template.
    `docker/compose/.env` is your local deployment file and should not be committed.

3. Start the stack:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env up -d
```

Migrations run automatically on startup.

4. Check the app health endpoint:

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
- run the same compose command shown above from that folder

## Updating

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env pull
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env up -d
```

Migrations run automatically on startup.

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

For application development, prefer the local Docker workflow rather than setting up a local Python environment:

- use `docker compose` to run the stack
- run tests and scripts inside the container

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FAMILY_LEDGER_API_TOKEN` | - | **Required**. Bearer token for all ledger API routes |
| `FAMILY_LEDGER_IMAGE` | `ghcr.io/fterrier/family-ledger:latest` | Container image to run |
| `FAMILY_LEDGER_DB_HOST` | `postgres` | PostgreSQL hostname (docker service name) |
| `FAMILY_LEDGER_LEDGER_CONFIG_PATH` | `/app/config/ledger.yaml` | Path to the mounted ledger config inside the container |
| `FAMILY_LEDGER_PAPERLESS_BASE_URL` | - | Base URL of the Paperless-ngx instance used for attachment storage |
| `FAMILY_LEDGER_PAPERLESS_TOKEN` | - | API token used to upload and poll Paperless ingestion tasks |
| `FAMILY_LEDGER_PAPERLESS_API_VERSION` | `10` | Paperless API version sent in the `Accept` header |
| `FAMILY_LEDGER_PAPERLESS_POLL_INTERVAL_SECONDS` | `30` | Poll interval for pending attachment ingestion tasks |
| `FAMILY_LEDGER_PAPERLESS_INGESTION_TIMEOUT_SECONDS` | `900` | Deadline before a pending attachment is marked `timed_out` |
| `FAMILY_LEDGER_ATTACHMENT_POLLER_ENABLED` | `true` | Enables the in-process attachment poller started with the API |

`docker/compose/.env.example` is the checked-in example. Copy it to `docker/compose/.env`
for a real deployment, then uncomment any optional Paperless settings you want to use.

## Tests

Run tests locally:

```bash
pytest
```

Install the local git hooks (requires local python environment):

```bash
pre-commit install
```

## Migrations

Migrations run automatically via the container entrypoint (`alembic upgrade head`) on every startup. No manual step is needed for standard deployments.

For local development, run Alembic directly:

```bash
alembic upgrade head
```

## Export

Export the full ledger to a Beancount file:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env \
  exec api export-beancount > ledger.beancount
```

Or write directly to a file inside the container:

```bash
docker compose -f docker/compose/docker-compose.yml --env-file docker/compose/.env \
  exec api export-beancount --output /tmp/ledger.beancount
```

The export includes all accounts, commodities, prices, transactions, and balance assertions
in Beancount syntax. Beancount metadata stored on import round-trips back as directive
metadata. Pad directives are represented as the synthetic transactions they generated.

To validate the output with Beancount's own checker:

```bash
bean-check ledger.beancount
```

## Fava

[Fava](https://beancount.github.io/fava/) is an optional web frontend for browsing the exported
Beancount ledger. It is configured as a separate compose override so the base stack is unaffected.

Start the stack with Fava:

```bash
docker compose \
  -f docker/compose/docker-compose.yml \
  -f docker/compose/docker-compose.fava.yml \
  --env-file docker/compose/.env up -d
```

Export the ledger to the shared volume:

```bash
docker compose \
  -f docker/compose/docker-compose.yml \
  -f docker/compose/docker-compose.fava.yml \
  --env-file docker/compose/.env \
  exec api export-beancount --output /export/ledger.beancount
```

Fava is then available at `http://localhost:5000`.

Re-run the export command whenever you want to refresh the view.

> **Note**: Fava has no authentication. If you expose this stack publicly (e.g. via Tailscale
> Funnel), put it behind a reverse proxy with auth or use Tailscale ACLs to restrict access.

## Demo Data

You can bootstrap a small example ledger into an empty database for local testing.

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

- `docs/specs/` — canonical current product and system behavior
- `docs/guides/` — contributor and operator guidance
- `docs/adr/` — architectural decisions and rationale
- `archive/docs/` — historical and superseded material

## Clients

- `clients/google-sheets/README.md`: user-facing install and usage guide for the Google Sheets client
- `clients/google-sheets/docs/`: client-local permissions and performance notes
