from __future__ import annotations

from typing import Any

from sqlalchemy import Select
from sqlalchemy.orm import Session

from family_ledger.services.errors import ValidationError

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


def normalize_page_size(page_size: int | None) -> int:
    if page_size is None:
        return DEFAULT_PAGE_SIZE
    if page_size <= 0:
        raise ValidationError(code="invalid_page_size", message="page_size must be positive")
    return min(page_size, MAX_PAGE_SIZE)


def decode_page_token(page_token: str | None) -> int:
    from base64 import urlsafe_b64decode

    if not page_token:
        return 0
    try:
        decoded = urlsafe_b64decode(page_token.encode()).decode()
        offset = int(decoded)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValidationError(code="invalid_page_token", message="Invalid page_token") from exc
    if offset < 0:
        raise ValidationError(code="invalid_page_token", message="Invalid page_token")
    return offset


def encode_page_token(offset: int) -> str:
    from base64 import urlsafe_b64encode

    return urlsafe_b64encode(str(offset).encode()).decode()


def paginate_query(query: Select, *, offset: int, page_size: int):
    return query.offset(offset).limit(page_size + 1)


def _run_list_page(
    session: Session, query: Select, *, page_size: int | None, page_token: str | None
) -> tuple[list[Any], str | None]:
    normalized = normalize_page_size(page_size)
    offset = decode_page_token(page_token)
    rows: list[Any] = list(
        session.scalars(paginate_query(query, offset=offset, page_size=normalized)).all()
    )
    next_token: str | None = None
    if len(rows) > normalized:
        rows = rows[:normalized]
        next_token = encode_page_token(offset + normalized)
    return rows, next_token
