from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from family_ledger.api.accounts import router as accounts_router
from family_ledger.api.attachment import router as attachment_router
from family_ledger.api.balance_assertions import router as balance_assertions_router
from family_ledger.api.commodities import router as commodities_router
from family_ledger.api.health import router as health_router
from family_ledger.api.importer import router as importer_router
from family_ledger.api.prices import router as prices_router
from family_ledger.api.transactions import router as transactions_router
from family_ledger.config import get_ledger_config, get_settings
from family_ledger.db import wait_for_database
from family_ledger.services import attachment_poller


def create_app() -> FastAPI:
    settings = get_settings()
    get_ledger_config()
    wait_for_database()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        del app
        poller = attachment_poller.start_attachment_poller(settings)
        try:
            yield
        finally:
            if poller is not None:
                attachment_poller.stop_attachment_poller(*poller)

    app = FastAPI(title="family-ledger", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(accounts_router)
    app.include_router(commodities_router)
    app.include_router(transactions_router)
    app.include_router(prices_router)
    app.include_router(balance_assertions_router)
    app.include_router(importer_router)
    app.include_router(attachment_router)
    return app


app = create_app()
