from __future__ import annotations

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


class ServiceError(Exception):
    def __init__(self, *, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


class ValidationError(ServiceError):
    pass


class NotFoundError(ServiceError):
    pass


class ConflictError(ServiceError):
    pass


class UnavailableError(ServiceError):
    pass


def commit_or_raise(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ConflictError(code="integrity_error", message=str(exc.orig)) from exc
