from __future__ import annotations

from decimal import Decimal

from api_helpers import create_commodity, make_client


def test_create_and_get_price() -> None:
    client = make_client()

    create_commodity(client, "CHF")
    create_commodity(client, "USD")

    create_response = client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-19",
                "base_symbol": "USD",
                "quote": {"amount": "0.92", "symbol": "CHF"},
            }
        },
    )

    assert create_response.status_code == 201
    body = create_response.json()
    assert body["name"].startswith("prices/prc_")
    assert body["quote"]["symbol"] == "CHF"

    get_response = client.get(f"/prices/{body['name']}")

    assert get_response.status_code == 200
    assert get_response.json()["base_symbol"] == "USD"


def test_update_price() -> None:
    client = make_client()
    create_commodity(client, "CHF")
    create_commodity(client, "USD")

    body = client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-19",
                "base_symbol": "USD",
                "quote": {"amount": "0.92", "symbol": "CHF"},
            }
        },
    ).json()
    name = body["name"]

    patch_response = client.patch(
        f"/{name}",
        json={
            "price": {
                "price_date": "2026-04-20",
                "base_symbol": "USD",
                "quote": {"amount": "0.95", "symbol": "CHF"},
            },
            "update_mask": "price_date,base_symbol,quote",
        },
    )
    assert patch_response.status_code == 200
    updated = patch_response.json()
    assert updated["price_date"] == "2026-04-20"
    assert Decimal(updated["quote"]["amount"]) == Decimal("0.95")
    assert updated["name"] == name


def test_update_price_rejects_unknown_symbol() -> None:
    client = make_client()
    create_commodity(client, "CHF")
    create_commodity(client, "USD")

    body = client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-19",
                "base_symbol": "USD",
                "quote": {"amount": "0.92", "symbol": "CHF"},
            }
        },
    ).json()

    patch_response = client.patch(
        f"/{body['name']}",
        json={
            "price": {
                "price_date": "2026-04-19",
                "base_symbol": "UNKNOWN",
                "quote": {"amount": "0.92", "symbol": "CHF"},
            },
            "update_mask": "price_date,base_symbol,quote",
        },
    )
    assert patch_response.status_code == 400


def test_create_price_rejects_unknown_symbol() -> None:
    client = make_client()

    response = client.post(
        "/prices",
        json={
            "price": {
                "price_date": "2026-04-19",
                "base_symbol": "USD",
                "quote": {"amount": "0.92", "symbol": "CHF"},
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "commodity_not_found"
