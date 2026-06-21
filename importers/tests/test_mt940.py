from __future__ import annotations

import json
from collections.abc import Generator
from datetime import date
from pathlib import Path
from typing import Any, cast

import pytest
from family_ledger_importers import mt940 as mt940_importer
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, selectinload

from family_ledger.importers.base import ImportContext
from family_ledger.models import Account, BalanceAssertion, Base, Commodity, Posting, Transaction
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
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000006F6F0006
:25:CH5612300000000100111
:28C:106/1
:60F:C250830CHF25500,00
:61:2508300901D22,2NMSCNONREF//L115B1119GR46F3P
Einkauf Bank Debit Card Nr. xx
:86:?ZKB:2218 Einkauf Bank Debit Card Nr. xxxx 4462,
SAMPLE PHARMACY GMBH 0000
:62F:C250830CHF25477,80
:64:C250830CHF25477,80
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000007G7G0007
:25:CH5612300000000100111
:28C:107/1
:60F:C250902CHF25477,80
:61:2509010902D104,5NMSCNONREF//L11591119GTT3NSZ
Einkauf Bank Debit Card Nr. xx
:86:?ZKB:2218 Einkauf Bank Debit Card Nr. xxxx 4462, Sample Store 1234
Sample City
:62F:C250902CHF25373,30
:64:C250902CHF25373,30
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000008H8H0008
:25:CH5612300000000100111
:28C:108/1
:60F:C250905CHF25373,30
:61:250905D44,4NTRF001700000001//001700000001
Debit Wallet: SAMPLE MARKET CITY
:86:?ZKB:2200
Debit Wallet: SAMPLE MARKET CITY
:62F:C250905CHF25328,90
:64:C250905CHF25328,90
-}
"""

DUPLICATE_ENTRIES_FIXTURE = """{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000010H0001
:25:CH5612300000000100111
:28C:110/1
:60F:C250901CHF1000,00
:61:2509010901D50,00NMSCNONREF
Same description
:86:Purchase
:62F:C250901CHF950,00
:64:C250901CHF950,00
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:F00000011H0002
:25:CH5612300000000100111
:28C:111/1
:60F:C250901CHF950,00
:61:2509010901D50,00NMSCNONREF
Same description
:86:Purchase
:62F:C250901CHF900,00
:64:C250901CHF900,00
-}
"""

BALANCE_FREQUENCY_FIXTURE = """{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:B00000001A1A0001
:25:CH5612300000000100111
:28C:201/1
:60F:C250701CHF1000,00
:61:250701D10,NTRFNONREF//BF001
Day one
:86:?ZKB:2200
Day one
:62F:C250701CHF990,00
:64:C250701CHF990,00
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:B00000002A2A0002
:25:CH5612300000000100111
:28C:202/1
:60F:C250702CHF990,00
:61:250702D20,NTRFNONREF//BF002
Day two
:86:?ZKB:2200
Day two
:62F:C250702CHF970,00
:64:C250702CHF970,00
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:B00000003A3A0003
:25:CH5612300000000100111
:28C:203/1
:60F:C250708CHF970,00
:61:250708D30,NTRFNONREF//BF003
Next week
:86:?ZKB:2200
Next week
:62F:C250708CHF940,00
:64:C250708CHF940,00
-}
{1:F01ZKBKCHZZP80A0000000000}{2:I940XXXXXXXXXXXXN}{4:
:20:B00000004A4A0004
:25:CH5612300000000100111
:28C:204/1
:60F:C250801CHF940,00
:61:250801D40,NTRFNONREF//BF004
Next month
:86:?ZKB:2200
Next month
:62F:C250801CHF900,00
:64:C250801CHF900,00
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
    mt940_importer.Mt940Importer().execute(
        ImportContext(session), {"file": MT940_FIXTURE.encode("utf-8")}, config or {}
    )


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
                "source_native_id": transaction.source_native_ids[0]
                if transaction.source_native_ids
                else None,
                "entity_metadata": transaction.entity_metadata,
                "bank_posting": {
                    "account": bank_posting.account.name,
                    "amount": str(bank_posting.units_amount),
                    "symbol": bank_posting.units_symbol,
                },
            }
        )
    return normalized


def _normalized_balance_assertions(session: Session) -> list[dict[str, object]]:
    assertions = session.scalars(
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .order_by(BalanceAssertion.assertion_date, BalanceAssertion.id)
    ).all()
    return [
        {
            "assertion_date": assertion.assertion_date.isoformat(),
            "account": assertion.account.name,
            "amount": str(assertion.amount),
            "symbol": assertion.symbol,
            "entity_metadata": assertion.entity_metadata,
        }
        for assertion in assertions
    ]


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


def test_mt940_importer_file_descriptors_accept_mt940_extension() -> None:
    descriptors = mt940_importer.Mt940Importer().get_file_descriptors()

    assert len(descriptors) == 1
    assert ".mt940" in descriptors[0]["accept"]
    assert ".txt" in descriptors[0]["accept"]
    assert ".sta" in descriptors[0]["accept"]


def test_mt940_importer_schema_account_mappings() -> None:
    schema = mt940_importer.Mt940Importer().get_schema()

    assert "required" not in schema
    assert schema["properties"]["account_mappings"]["default"] == {}
    assert schema["properties"]["payee_format"]["default"] == "generic"
    assert schema["properties"]["balance_assertion_frequency"]["default"] == "none"
    assert (
        schema["properties"]["account_mappings"]["additionalProperties"]["x-resource-type"]
        == "account"
    )


def test_parse_mt940_text_uses_library_fields_for_dates_and_refs() -> None:
    entries, balances = cast(
        tuple[list[Any], list[Any]],
        mt940_importer._parse_mt940_text(MT940_FIXTURE),
    )

    assert len(entries) == 8
    assert len(balances) == 8
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
    assert entries[5].ref == "L115B1119GR46F3P"
    assert entries[6].ref == "L11591119GTT3NSZ"
    assert entries[7].ref == "001700000001"
    assert balances[0].closing_balance_date.isoformat() == "2025-12-31"
    assert str(balances[0].closing_amount) == "5002.50"


def test_normalize_description_collapses_duplicates() -> None:
    payee = mt940_importer.normalize_description(["Guthabenzins", "Guthabenzins"])

    assert payee == "Guthabenzins"


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

    assert normalized[0]["payee"] == (
        "Testcard Services SA Musterstrasse 1 CH-8001 Musterstadt Gemaess Ihrem eBanking Auftrag"
    )
    assert normalized[0]["narration"] is None
    assert normalized[0]["source_native_id"] == "mt940:T201000000001"
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
    assert normalized[1]["narration"] is None
    assert normalized[1]["source_native_id"] == "mt940:002000000002"
    assert normalized[2]["payee"] == (
        "Sample Motors AG Industriestr 42 8000 Musterstadt "
        "Rechnungsnummer 1000001 Gemaess Ihrem Mobile Banking Auftrag"
    )
    assert normalized[2]["narration"] is None
    assert normalized[3]["payee"] == (
        "ACME SCHWEIZ GMBH 1,MUSTERPLATZ MUSTERSTADT,MUSTERSTADT,8000 CH 00100001 SALARY 202507"
    )
    assert normalized[3]["narration"] is None
    assert normalized[3]["source_native_id"] == "mt940:T201000000004"
    assert normalized[4]["payee"] == (
        "Einkauf Bank Debit Card Nr. xxxx 4462 SAMPLE PHARMACY GMBH 0000"
    )
    assert normalized[4]["narration"] is None
    assert normalized[5]["payee"] == (
        "Einkauf Bank Debit Card Nr. xxxx 4462, Sample Store 1234 Sample City"
    )
    assert normalized[5]["narration"] is None
    assert normalized[6]["payee"] == "Debit Wallet: SAMPLE MARKET CITY"
    assert normalized[6]["narration"] is None
    assert normalized[6]["source_native_id"] == "mt940:001700000001"
    assert normalized[7]["payee"] == "Guthabenzins"
    assert normalized[7]["narration"] is None
    assert normalized[7]["source_native_id"] is not None
    assert str(normalized[7]["source_native_id"]).startswith("mt940:fp:")

    assertions = _normalized_balance_assertions(session)
    assert assertions == []


def test_mt940_importer_creates_daily_balance_assertions_with_metadata(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")

    _run(
        session,
        {
            "account_mappings": {
                "CH5612300000000100111": account_resource,
                "CH4512300000000200222": account_resource,
            },
            "balance_assertion_frequency": "daily",
        },
    )

    assertions = _normalized_balance_assertions(session)
    assert len(assertions) == 8
    assert assertions[0] == {
        "assertion_date": "2025-07-04",
        "account": account_resource,
        "amount": "19814.7000000000",
        "symbol": "CHF",
        "entity_metadata": {
            "mt940": {
                "statement_reference": "F00000002B2B0002",
                "account_iban": "CH5612300000000100111",
                "statement_number": "102/1",
                "closing_balance_date": "2025-07-03",
            }
        },
    }
    assert assertions[-1] == {
        "assertion_date": "2026-01-01",
        "account": account_resource,
        "amount": "5002.5000000000",
        "symbol": "CHF",
        "entity_metadata": {
            "mt940": {
                "statement_reference": "F00000001A1A0001",
                "account_iban": "CH4512300000000200222",
                "statement_number": "101/1",
                "closing_balance_date": "2025-12-31",
            }
        },
    }


def test_mt940_importer_supports_zkb_structural_payee_format(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")

    _run(
        session,
        {
            "account_mappings": {
                "CH5612300000000100111": account_resource,
                "CH4512300000000200222": account_resource,
            },
            "payee_format": "zkb",
        },
    )

    normalized = _normalized_transactions(session)

    assert normalized[0]["payee"] == (
        "Testcard Services SA Musterstrasse 1 CH-8001 Musterstadt Gemaess Ihrem eBanking Auftrag"
    )
    assert normalized[1]["payee"] == "SAMPLE CITY, SPORTS DEPT - Belastung TWINT"
    assert normalized[2]["payee"] == (
        "Sample Motors AG Industriestr 42 8000 Musterstadt "
        "Rechnungsnummer 1000001 Gemaess Ihrem Mobile Banking Auftrag"
    )
    assert normalized[4]["payee"] == (
        "SAMPLE PHARMACY GMBH 0000 - Einkauf Bank Debit Card Nr. xxxx 4462"
    )
    assert normalized[5]["payee"] == (
        "Sample Store 1234 Sample City - Einkauf Bank Debit Card Nr. xxxx 4462"
    )
    assert normalized[6]["payee"] == "SAMPLE MARKET CITY - Debit Wallet"


def test_format_payee_supports_instant_payment_ordering() -> None:
    payee = mt940_importer._format_payee(  # pyright: ignore[reportAttributeAccessIssue]
        [
            "Instant-Zahlung: Sample Lender SA,",
            "Sample Lender SA",
            "Case postale 123",
            "CH-8000 Sample City",
            "Reference 987",
            "Gemaess Ihrem Mobile Banking Auftrag",
        ],
        "zkb",
    )

    assert payee == (
        "Sample Lender SA Case postale 123 CH-8000 Sample City "
        "Reference 987 Gemaess Ihrem Mobile Banking Auftrag - Instant-Zahlung"
    )


def test_format_payee_supports_twint_ordering() -> None:
    payee = mt940_importer._format_payee(  # pyright: ignore[reportAttributeAccessIssue]
        [
            "Belastung TWINT: STADT ZUERICH, SPORTAMT ZURICH",
        ],
        "zkb",
    )

    assert payee == "STADT ZUERICH, SPORTAMT ZURICH - Belastung TWINT"


def test_format_payee_supports_einkauf_ordering() -> None:
    payee = mt940_importer._format_payee(  # pyright: ignore[reportAttributeAccessIssue]
        [
            "Einkauf Bank Debit Card Nr. xxxx 4462, Sample Store 1234",
            "Sample City",
        ],
        "zkb",
    )

    assert payee == "Sample Store 1234 Sample City - Einkauf Bank Debit Card Nr. xxxx 4462"


def test_format_payee_supports_mobile_banking_ordering() -> None:
    payee = mt940_importer._format_payee(  # pyright: ignore[reportAttributeAccessIssue]
        [
            "Belastung (1) Mobile Banking",
            "Stadt Zürich Schulgesundheitsdienst 8027 Zürich CH",
        ],
        "zkb",
    )

    assert (
        payee == "Stadt Zürich Schulgesundheitsdienst 8027 Zürich CH - Belastung (1) Mobile Banking"
    )


def test_format_payee_supports_dauerauftrag_ordering() -> None:
    payee = mt940_importer._format_payee(  # pyright: ignore[reportAttributeAccessIssue]
        [
            "Belastung (2) Dauerauftrag",
            "ERSIAN AG Schaeronmoosstrasse 77 8052 Zürich CH",
        ],
        "zkb",
    )

    assert payee == "ERSIAN AG Schaeronmoosstrasse 77 8052 Zürich CH - Belastung (2) Dauerauftrag"


def _run_fixture(session: Session, fixture: str, config: dict[str, Any]) -> None:
    mt940_importer.Mt940Importer().execute(
        ImportContext(session), {"file": fixture.encode("utf-8")}, config
    )


def test_mt940_importer_duplicate_entries_get_different_source_native_ids(
    session: Session,
) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    config = {"account_mappings": {"CH5612300000000100111": account_resource}}

    _run_fixture(session, DUPLICATE_ENTRIES_FIXTURE, config)

    transactions = session.scalars(select(Transaction).order_by(Transaction.id)).all()
    assert len(transactions) == 2
    assert transactions[0].source_native_ids != transactions[1].source_native_ids
    assert transactions[0].source_native_ids
    assert transactions[0].source_native_ids[0].startswith("mt940:fp:")
    assert transactions[1].source_native_ids[0].startswith("mt940:fp:")


def test_mt940_importer_fallback_source_native_id_is_deterministic(
    session: Session,
) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    config = {"account_mappings": {"CH5612300000000100111": account_resource}}

    _run_fixture(session, DUPLICATE_ENTRIES_FIXTURE, config)
    first_ids = sorted(
        t.source_native_ids[0]
        for t in session.scalars(select(Transaction)).all()
        if t.source_native_ids
    )

    engine2 = create_engine("sqlite+pysqlite:///:memory:")
    from family_ledger.models import Base as _Base

    _Base.metadata.create_all(engine2)
    with Session(engine2) as session2:
        account2 = Account(
            name="accounts/family",
            account_name="Assets:Liquid:ZKB:Checking:Family",
            effective_start_date=date(2020, 1, 1),
            effective_end_date=None,
            entity_metadata={},
        )
        session2.add(account2)
        session2.commit()
        _run_fixture(
            session2,
            DUPLICATE_ENTRIES_FIXTURE,
            {"account_mappings": {"CH5612300000000100111": account2.name}},
        )
        second_ids = sorted(
            t.source_native_ids[0]
            for t in session2.scalars(select(Transaction)).all()
            if t.source_native_ids
        )

    assert first_ids == second_ids


def test_mt940_importer_provider_prefix_overrides_default(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    config = {
        "account_mappings": {"CH5612300000000100111": account_resource},
        "provider_prefix": "zkb",
    }

    _run_fixture(session, DUPLICATE_ENTRIES_FIXTURE, config)

    transactions = session.scalars(select(Transaction).order_by(Transaction.id)).all()
    assert all(
        t.source_native_ids and t.source_native_ids[0].startswith("zkb:fp:") for t in transactions
    )


def test_mt940_importer_deduplicates_on_reimport(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    config = {
        "account_mappings": {
            "CH5612300000000100111": account_resource,
            "CH4512300000000200222": account_resource,
        },
        "balance_assertion_frequency": "daily",
    }

    result1 = mt940_importer.Mt940Importer().execute(
        ImportContext(session), {"file": MT940_FIXTURE.encode("utf-8")}, config
    )
    result2 = mt940_importer.Mt940Importer().execute(
        ImportContext(session), {"file": MT940_FIXTURE.encode("utf-8")}, config
    )

    created = result1.entities["transaction"].created
    assert created > 0
    assert result2.entities["transaction"].created == 0
    assert result2.entities["transaction"].duplicate == created
    assertion_created = result1.entities["balance_assertion"].created
    assert assertion_created == 8
    assert result2.entities["balance_assertion"].created == 0
    assert result2.entities["balance_assertion"].duplicate == assertion_created


def test_mt940_importer_creates_balance_assertion_series_for_statement_closings(
    session: Session,
) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    config: dict[str, object] = {
        "account_mappings": {
            "CH5612300000000100111": account_resource,
            "CH4512300000000200222": account_resource,
        },
        "balance_assertion_frequency": "daily",
    }

    _run(session, config)

    assertions = _normalized_balance_assertions(session)
    assert [assertion["assertion_date"] for assertion in assertions] == [
        "2025-07-04",
        "2025-07-08",
        "2025-07-12",
        "2025-07-26",
        "2025-08-31",
        "2025-09-03",
        "2025-09-06",
        "2026-01-01",
    ]


def test_mt940_importer_balance_assertion_frequency_weekly(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    mt940_importer.Mt940Importer().execute(
        ImportContext(session),
        {"file": BALANCE_FREQUENCY_FIXTURE.encode("utf-8")},
        {
            "account_mappings": {"CH5612300000000100111": account_resource},
            "balance_assertion_frequency": "weekly",
        },
    )

    assertions = _normalized_balance_assertions(session)
    assert [assertion["assertion_date"] for assertion in assertions] == [
        "2025-07-02",
        "2025-07-09",
        "2025-08-02",
    ]


def test_mt940_importer_balance_assertion_frequency_monthly(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    mt940_importer.Mt940Importer().execute(
        ImportContext(session),
        {"file": BALANCE_FREQUENCY_FIXTURE.encode("utf-8")},
        {
            "account_mappings": {"CH5612300000000100111": account_resource},
            "balance_assertion_frequency": "monthly",
        },
    )

    assertions = _normalized_balance_assertions(session)
    assert [assertion["assertion_date"] for assertion in assertions] == [
        "2025-07-02",
        "2025-08-02",
    ]


def test_mt940_importer_diff_matches_current_family_subset_fixture(session: Session) -> None:
    account_resource = _create_account(session, "Assets:Liquid:ZKB:Checking:Family")
    _run(
        session,
        {
            "account_mappings": {
                "CH5612300000000100111": account_resource,
                "CH4512300000000200222": account_resource,
            },
            "payee_format": "zkb",
        },
    )

    expected_path = (
        Path(__file__).with_name("fixtures").joinpath("mt940_family_subset_expected.json")
    )
    expected = json.loads(expected_path.read_text())

    assert _diff_projection(_normalized_transactions(session)) == expected
