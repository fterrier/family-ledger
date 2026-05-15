# Deployment

## Default Runtime Shape

The project is deployed as a Docker Compose stack with PostgreSQL and the API service.

Migrations run automatically on startup.

## Core Runtime Requirements

- set a real `FAMILY_LEDGER_API_TOKEN`
- provide a ledger config file
- keep PostgreSQL data persistent across restarts

## Google Sheets Requirement

Google Apps Script cannot call `localhost` or a private-only address.

If you use the Sheets client, the API must be reachable over public HTTPS. The current recommended approach is to expose the service with Tailscale Funnel and use the same bearer token in both the server and Sheets client.

## Main References

- top-level `README.md` for deployment commands
- `clients/google-sheets/README.md` for Apps Script deployment
