# Deployment

## Default Runtime Shape

The project is deployed as a Docker Compose stack with PostgreSQL and the API service.

Migrations run automatically on startup.

## Core Runtime Requirements

- set a real `FAMILY_LEDGER_API_TOKEN`
- provide a ledger config file
- keep PostgreSQL data persistent across restarts

## Attachment Storage

If you want attachment uploads, configure Paperless-ngx access:

- `FAMILY_LEDGER_PAPERLESS_BASE_URL`
- `FAMILY_LEDGER_PAPERLESS_TOKEN`

Optional tuning:

- `FAMILY_LEDGER_PAPERLESS_TAG_IDS` — comma-separated Paperless tag IDs applied to every uploaded attachment
- `FAMILY_LEDGER_PAPERLESS_API_VERSION` defaults to `10`; set to `9` if your Paperless instance does not support version 10
- `FAMILY_LEDGER_PAPERLESS_POLL_INTERVAL_SECONDS` defaults to `30`
- `FAMILY_LEDGER_PAPERLESS_INGESTION_TIMEOUT_SECONDS` defaults to `900`
- `FAMILY_LEDGER_ATTACHMENT_POLLER_ENABLED` defaults to `true`

The API service starts a simple in-process poller that watches pending attachment ingestion tasks and marks them as `stored`, `failed`, or `timed_out` based on persisted backend state.

## Google Sheets Requirement

Google Apps Script cannot call `localhost` or a private-only address.

If you use the Sheets client, the API must be reachable over public HTTPS. The current recommended approach is to expose the service with Tailscale Funnel and use the same bearer token in both the server and Sheets client.

## Main References

- top-level `README.md` for deployment commands
- `clients/google-sheets/README.md` for Apps Script deployment
