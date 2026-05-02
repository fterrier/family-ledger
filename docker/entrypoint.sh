#!/bin/sh
set -e
alembic upgrade head
exec uvicorn family_ledger.main:app --host 0.0.0.0 --port 8000
