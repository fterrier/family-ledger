from __future__ import annotations

from fastapi import FastAPI

from family_ledger.api.health import router as health_router
from family_ledger.api.importer import router as importer_router
from family_ledger.api.ledger import router as ledger_router
from family_ledger.config import get_ledger_config, get_settings
from family_ledger.db import SessionLocal, ping_database
from family_ledger.importers.registry import bootstrap_importers


def create_app() -> FastAPI:
    settings = get_settings()
    get_ledger_config()
    ping_database()

    with SessionLocal() as session:
        bootstrap_importers(session)

    app = FastAPI(title="family-ledger", version="0.1.0")
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(ledger_router)
    app.include_router(importer_router)
    return app


app = create_app()
