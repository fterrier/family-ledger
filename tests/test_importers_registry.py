from __future__ import annotations

from collections.abc import Generator
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from family_ledger.importers.base import BaseImporter, ImportResult
from family_ledger.importers.registry import get_importer, get_importers


class _FakeImporter(BaseImporter):
    name = "fake"
    display_name = "Fake Importer"

    def execute(self, session: Session, file_data: bytes, config: dict) -> ImportResult:  # type: ignore[override]
        return ImportResult()


@pytest.fixture(autouse=True)
def reset_importers_cache(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    monkeypatch.setattr("family_ledger.importers.registry._importers", None)
    yield
    monkeypatch.setattr("family_ledger.importers.registry._importers", None)


def test_get_importers_with_no_entry_points_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("family_ledger.importers.registry.entry_points", lambda **_: [])

    assert get_importers() == {}


def test_get_importers_loads_entry_points(monkeypatch: pytest.MonkeyPatch) -> None:
    ep = MagicMock()
    ep.name = "fake"
    ep.load.return_value = _FakeImporter
    monkeypatch.setattr("family_ledger.importers.registry.entry_points", lambda **_: [ep])

    importers = get_importers()

    assert importers == {"fake": _FakeImporter}


def test_get_importers_caches_result(monkeypatch: pytest.MonkeyPatch) -> None:
    call_count = 0

    def fake_entry_points(**_):  # type: ignore[no-untyped-def]
        nonlocal call_count
        call_count += 1
        return []

    monkeypatch.setattr("family_ledger.importers.registry.entry_points", fake_entry_points)

    get_importers()
    get_importers()

    assert call_count == 1


def test_get_importer_returns_class(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("family_ledger.importers.registry._importers", {"fake": _FakeImporter})

    assert get_importer("fake") is _FakeImporter


def test_get_importer_returns_none_for_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("family_ledger.importers.registry._importers", {})

    assert get_importer("unknown") is None
