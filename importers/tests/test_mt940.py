from __future__ import annotations

import json
from collections.abc import Generator
from datetime import date
from pathlib import Path

import pytest
from family_ledger_importers import mt940 as mt940_importer
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, selectinload

from family_ledger.models import Account, Base, Commodity, Posting, Transaction
from family_ledger.services.errors import ValidationError

MT940_FIXTURE = """{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000001A1A0001
:25:CH4512300000000200222
:28C:101/1
:60F:C251231CHF5000,00
:61:251231C2,5NINTNONREF
Habenzins
:86:?ZKB:2196
Guthabenzins
:62F:C251231CHF5002,50
:64:C251231CHF5002,50
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000002B2B0002
:25:CH5612300000000100111
:28C:102/1
:60F:C250703CHF20000,00
:61:250703D185,3NTRFNONREF//T201000000001
eBill: Testcard Services SA,
:86:?ZKB:2214
Testcard Services SA
Musterstrasse 1
CH-8001 Musterstadt
Gemaess Ihrem eBanking Auftrag
?ZI:?9:1
:62F:C250703CHF19814,70
:64:C250703CHF19814,70
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000003C3C0003
:25:CH5612300000000100111
:28C:103/1
:60F:C250707CHF19814,70
:61:2507050707D24,5NTRF002000000002//002000000002
Belastung TWINT: SAMPLE CITY, SP
:86:?ZKB:2200
Belastung TWINT: SAMPLE CITY, SPORTS DEPT
:62F:C250707CHF19790,20
:64:C250707CHF19790,20
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000004D4D0004
:25:CH5612300000000100111
:28C:104/1
:60F:C250711CHF19790,20
:61:250711D350,NTRFNONREF//T201000000003
Mobile Banking: Sample Motors AG,
:86:?ZKB:2214 Sample Motors AG
Industriestr 42
8000 Musterstadt
Rechnungsnummer 1000001
Gemaess Ihrem Mobile Banking Auftrag
?ZI:?9:1
:62F:C250711CHF19440,20
:64:C250711CHF19440,20
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000005E5E0005
:25:CH5612300000000100111
:28C:105/1
:60F:C250725CHF17000,00
:61:250725C8500,NTRFLON00000000001//T201000000004
Gutschrift: ACME SCHWEIZ GMBH
:86:?ZKB:2313
ACME SCHWEIZ GMBH
1,MUSTERPLATZ MUSTERSTADT,MUSTERSTADT,8000 CH
00100001 SALARY 202507
?ZI:?4:CHF0,?9:1
:62F:C250725CHF25500,00
:64:C250725CHF25500,00
-}
"""


@pytest.fixture
def session() -> Generator[Session, None, None]:
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)

    with Session(engine) as s:
        yield s


def _create_account(session: Session, account_name: str) -> str:
    account = Account(
        name="accounts/family",
        account_name=account_name,
        effective_start_date=date(2020, 1, 1),
        effective_end_date=None,
        entity_metadata={},
    )
    session.add(account)
    session.commit()
    return account.name


def _run(session: Session, config: dict[str, object] | None = None) -> None:
    mt940_importer.Mt940Importer().execute(session, MT940_FIXTURE.encode("utf-8"), config or {})


def _normalized_transactions(session: Session) -> list[dict[str, object]]:
    transactions = session.scalars(
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .order_by(Transaction.transaction_date, Transaction.id)
    ).all()
    normalized: list[dict[str, object]] = []
    for transaction in transactions:
        bank_posting = transaction.postings[0]
        normalized.append(
            {
                "transaction_date": transaction.transaction_date.isoformat(),
                "payee": transaction.payee,
                "narration": transaction.narration,
                "source_native_id": transaction.source_native_id,
                "entity_metadata": transaction.entity_metadata,
                "bank_posting": {
                    "account": bank_posting.account.name,
                    "amount": str(bank_posting.units_amount),
                    "symbol": bank_posting.units_symbol,
                },
            }
        )
    return normalized


def _diff_projection(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    projected: list[dict[str, object]] = []
    for row in rows:
        projected.append(
            {
                "transaction_date": row["transaction_date"],
                "payee": row["payee"],
                "narration": row["narration"],
                "bank_posting": row["bank_posting"],
            }
        )
    return projected


def test_mt940_importer_schema_requires_account_mappings() -> None:
    schema = mt940_importer.Mt940Importer().get_schema()

    assert schema["required"] == ["account_mappings"]
    assert (
        schema["properties"]["account_mappings"]["additionalProperties"]["x-resource-type"]
        == "account"
    )


def test_parse_mt940_text_uses_library_fields_for_dates_and_refs() -> None:
    entries = mt940_importer._parse_mt940_text(MT940_FIXTURE)

    assert len(entries) == 5
    assert entries[0].statement_number == "101/1"
    assert entries[1].transaction_code == "TRF"
    assert entries[1].ref == "T201000000001"
    assert entries[2].value_date.isoformat() == "2025-07-05"
    assert entries[2].entry_date is not None
    assert entries[2].entry_date.isoformat() == "2025-07-07"
    assert entries[2].effective_transaction_date.isoformat() == "2025-07-07"
    assert entries[2].ref == "002000000002"
    assert entries[0].transaction_code == "INT"
    assert entries[0].ref is None


def test_normalize_description_collapses_duplicates() -> None:
    payee, narration = mt940_importer._normalize_description(["Guthabenzins", "Guthabenzins"])

    assert payee == "Guthabenzins"
    assert narration is None


def test_mt940_importer_requires_complete_account_mapping(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")

    with pytest.raises(ValidationError) as exc_info:
        _run(session, {"account_mappings": {"CH5612300000000100111": account_resource}})

    assert exc_info.value.code == "missing_account_mapping"


def test_mt940_importer_requires_existing_mapped_account(session: Session) -> None:
    with pytest.raises(ValidationError) as exc_info:
        _run(
            session,
            {
                "account_mappings": {
                    "CH5612300000000100111": "accounts/missing_family",
                    "CH4512300000000200222": "accounts/missing_interest",
                }
            },
        )

    assert exc_info.value.code == "account_not_found"


def test_mt940_importer_creates_source_only_transactions_with_metadata(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")

    _run(
        session,
        {
            "account_mappings": {
                "CH5612300000000100111": account_resource,
                "CH4512300000000200222": account_resource,
            }
        },
    )

    assert session.scalar(select(Commodity.symbol).where(Commodity.symbol == "CHF")) == "CHF"

    normalized = _normalized_transactions(session)

    assert normalized[0]["payee"] == "Testcard Services SA"
    assert normalized[0]["narration"] == (
        "Musterstrasse 1 CH-8001 Musterstadt Gemaess Ihrem eBanking Auftrag"
    )
    assert normalized[0]["source_native_id"] == "T201000000001"
    assert normalized[0]["entity_metadata"] == {
        "mt940": {
            "statement_reference": "F00000002B2B0002",
            "account_iban": "CH5612300000000100111",
            "statement_number": "102/1",
            "value_date": "2025-07-03",
            "entry_date": None,
            "effective_transaction_date": "2025-07-03",
            "ref": "T201000000001",
            "transaction_code": "TRF",
        }
    }
    assert normalized[0]["bank_posting"] == {
        "account": account_resource,
        "amount": "-185.3000000000",
        "symbol": "CHF",
    }

    assert normalized[1]["transaction_date"] == "2025-07-07"
    assert normalized[1]["source_native_id"] == "002000000002"
    assert normalized[2]["payee"] == "Sample Motors AG"
    assert normalized[2]["narration"] == (
        "Industriestr 42 8000 Musterstadt "
        "Rechnungsnummer 1000001 Gemaess Ihrem Mobile Banking Auftrag"
    )
    assert normalized[3]["payee"] == "ACME SCHWEIZ GMBH"
    assert normalized[3]["source_native_id"] == "T201000000004"
    assert normalized[4]["payee"] == "Guthabenzins"
    assert normalized[4]["source_native_id"] is None


@pytest.mark.xfail(
    strict=False, reason="Formatting parity with current Family imports under review"
)
def test_mt940_importer_diff_matches_current_family_subset_fixture(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    _run(
        session,
        {
            "account_mappings": {
                "CH5612300000000100111": account_resource,
                "CH4512300000000200222": account_resource,
            }
        },
    )

    expected_path = (
        Path(__file__).with_name("fixtures").joinpath("mt940_family_subset_expected.json")
    )
    expected = json.loads(expected_path.read_text())

    assert _diff_projection(_normalized_transactions(session)) == expected
