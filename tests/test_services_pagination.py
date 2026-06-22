from __future__ import annotations

import pytest

from family_ledger.services import pagination as pagination_service
from family_ledger.services.errors import ValidationError as LedgerValidationError


def test_normalize_page_size_raises_for_non_positive() -> None:
    with pytest.raises(LedgerValidationError) as exc_info:
        pagination_service.normalize_page_size(0)

    assert exc_info.value.code == "invalid_page_size"


def test_decode_page_token_raises_for_garbage() -> None:
    with pytest.raises(LedgerValidationError) as exc_info:
        pagination_service.decode_page_token("!!!not-base64!!!")

    assert exc_info.value.code == "invalid_page_token"


def test_decode_page_token_raises_for_negative_offset() -> None:
    from base64 import urlsafe_b64encode

    token = urlsafe_b64encode(b"-5").decode()
    with pytest.raises(LedgerValidationError) as exc_info:
        pagination_service.decode_page_token(token)

    assert exc_info.value.code == "invalid_page_token"
