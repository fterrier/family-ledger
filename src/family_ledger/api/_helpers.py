from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from family_ledger.db import get_db_session
from family_ledger.services.errors import (
    ConflictError,
    NotFoundError,
    ServiceError,
    UnavailableError,
    ValidationError,
)

DbSession = Annotated[Session, Depends(get_db_session)]


def _translate_service_error(error: ServiceError) -> HTTPException:
    if isinstance(error, ValidationError):
        status_code = status.HTTP_400_BAD_REQUEST
    elif isinstance(error, NotFoundError):
        status_code = status.HTTP_404_NOT_FOUND
    elif isinstance(error, ConflictError):
        status_code = status.HTTP_409_CONFLICT
    elif isinstance(error, UnavailableError):
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    else:
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR

    return HTTPException(
        status_code=status_code,
        detail={
            "code": error.code,
            "message": error.message,
        },
    )


def _call_service(fn, *args, **kwargs):  # type: ignore[no-untyped-def]
    try:
        return fn(*args, **kwargs)
    except ServiceError as error:
        raise _translate_service_error(error) from error
