from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from family_ledger.config import Settings, get_settings


def require_api_token(
    authorization: Annotated[str | None, Header()] = None,
    settings: Annotated[Settings | None, Depends(get_settings)] = None,
) -> None:
    assert settings is not None
    expected = f"Bearer {settings.api_token}"
    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "unauthenticated",
                "message": "Missing or invalid API token",
            },
            headers={"WWW-Authenticate": "Bearer"},
        )
