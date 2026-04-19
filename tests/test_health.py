from __future__ import annotations

import importlib

from fastapi.testclient import TestClient


def test_healthz_returns_ok() -> None:
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    client = TestClient(main_module.create_app())

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
