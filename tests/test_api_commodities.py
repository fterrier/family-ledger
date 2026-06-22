from __future__ import annotations

import importlib

from fastapi.testclient import TestClient


def make_client(api_token: str = "test-token") -> TestClient:
    main_module = importlib.import_module("family_ledger.main")
    main_module = importlib.reload(main_module)
    return TestClient(
        main_module.create_app(),
        headers={"Authorization": f"Bearer {api_token}"},
    )


def create_commodity(client: TestClient, symbol: str) -> dict:
    response = client.post(
        "/commodities",
        json={"commodity": {"symbol": symbol}},
    )
    assert response.status_code == 201
    return response.json()


def test_create_and_get_commodity() -> None:
    client = make_client()

    create_response = create_commodity(client, "CHF")

    assert create_response["name"].startswith("commodities/cmd_")

    get_response = client.get(f"/{create_response['name']}")

    assert get_response.status_code == 200
    assert get_response.json() == {
        "name": create_response["name"],
        "symbol": "CHF",
        "ticker": None,
        "entity_metadata": {},
    }


def test_delete_commodity_removes_it_and_returns_204() -> None:
    client = make_client()
    data = create_commodity(client, "CHF")
    name = data["name"]

    delete_resp = client.delete(f"/{name}")
    assert delete_resp.status_code == 204

    get_resp = client.get(f"/{name}")
    assert get_resp.status_code == 404


def test_delete_missing_commodity_returns_404() -> None:
    client = make_client()

    response = client.delete("/commodities/cmd_nonexistent")
    assert response.status_code == 404


def test_list_commodities_supports_pagination() -> None:
    client = make_client()

    for symbol in ["CHF", "GOOG", "USD"]:
        create_commodity(client, symbol)

    first_page = client.get("/commodities?page_size=2")

    assert first_page.status_code == 200
    body = first_page.json()
    assert len(body["commodities"]) == 2
    assert body["next_page_token"] is not None

    second_page = client.get(f"/commodities?page_size=2&page_token={body['next_page_token']}")

    assert second_page.status_code == 200
    assert len(second_page.json()["commodities"]) == 1
    assert second_page.json()["next_page_token"] is None
