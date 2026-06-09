from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from camelot.io import read_pdf as camelot_read_pdf

from family_ledger.api.schemas import (
    BalanceAssertionCreate,
    ImportMetadata,
    MoneyValue,
    PostingNormalizePayload,
    TransactionNormalizeData,
)
from family_ledger.config import Settings
from family_ledger.importers.base import BaseImporter, ImportContext, ImportResult
from family_ledger.services.errors import ValidationError

_DATE_PATTERN = re.compile(r"^\d\d\.\d\d\.\d\d$")
_FILENAME_DATE_PATTERN = re.compile(r"visebpp_(\d{8})_")
_CARD_INFO_RE = re.compile(r"^\d{4}\s")
_TOTAL_CARTE_RE = re.compile(r"Total carte .+ (\d{4})$")
_MONTANT_DU_RE = re.compile(r"^[Mm]ontant\s+d[uû]$")


@dataclass(frozen=True)
class ParsedVisecaEntry:
    value_date: str
    amount_str: str  # raw amount; trailing " -" = credit, "'" = thousand separator
    details: str


@dataclass(frozen=True)
class ParsedVisecaSection:
    card_last4: str
    entries: list[ParsedVisecaEntry]
    total_chf: Decimal | None  # from "Total carte" row; positive = amount charged to this card


@dataclass(frozen=True)
class ParsedVisecaStatement:
    preamble_entries: list[ParsedVisecaEntry]  # entries before first card section (e.g. payments)
    sections: list[ParsedVisecaSection]
    total_due_chf: Decimal | None  # from "Montant dû"; positive = total amount owed


def _parse_rows(
    rows: list[tuple[str, str, str, str, str, str]],
) -> list[ParsedVisecaEntry]:
    """Parse (date, valueDate, details, _, _, amountChf) tuples into entries.

    Rows where `date` matches DD.MM.YY start a new transaction.
    Rows with empty `date` and empty `amountChf` are multi-line detail continuations.
    All other rows (headers, totals, card-info lines) are skipped.
    """
    entries: list[ParsedVisecaEntry] = []
    last_value_date: str | None = None
    last_amount_str: str | None = None
    last_details: str = ""

    for date_col, value_date, details, _, _, amount_chf in rows:
        date_col = date_col.strip()
        amount_chf = amount_chf.strip()
        details = details.strip()

        if _DATE_PATTERN.match(date_col):
            if last_value_date is not None:
                entries.append(
                    ParsedVisecaEntry(
                        value_date=last_value_date,
                        amount_str=last_amount_str or "",
                        details=last_details,
                    )
                )
            last_value_date = value_date.strip()
            last_amount_str = amount_chf
            last_details = details
        elif not date_col and not amount_chf:
            if details and last_value_date is not None:
                last_details = (last_details + " " + details).strip()

    if last_value_date is not None:
        entries.append(
            ParsedVisecaEntry(
                value_date=last_value_date,
                amount_str=last_amount_str or "",
                details=last_details,
            )
        )

    return entries


def _strip_thousands(s: str) -> Decimal:
    """Parse a CHF total amount; trailing ' -' means credit (owed to customer → negative)."""
    normalized = s.replace("'", "").strip()
    if normalized.endswith("-"):
        return -Decimal(normalized[:-1].strip())
    return Decimal(normalized)


def _parse_statement(
    all_rows: list[tuple[str, str, str, str, str, str]],
) -> ParsedVisecaStatement:
    """Parse all PDF rows into a structured statement with card sections and balance.

    Detects card info rows to split transactions per card, captures per-card
    "Total carte" totals, and reads the "Montant dû" grand total.
    """
    preamble: list[ParsedVisecaEntry] = []
    sections: list[ParsedVisecaSection] = []
    total_due_chf: Decimal | None = None

    current_card_last4: str | None = None
    current_section_entries: list[ParsedVisecaEntry] = []

    last_value_date: str | None = None
    last_amount_str: str | None = None
    last_details: str = ""

    def flush_entry() -> None:
        nonlocal last_value_date, last_amount_str, last_details
        if last_value_date is not None:
            target = current_section_entries if current_card_last4 is not None else preamble
            target.append(
                ParsedVisecaEntry(
                    value_date=last_value_date,
                    amount_str=last_amount_str or "",
                    details=last_details,
                )
            )
        last_value_date = None
        last_amount_str = None
        last_details = ""

    for date_col, value_date, details, _, _, amount_chf in all_rows:
        date_col = date_col.strip()
        amount_chf = amount_chf.strip()
        details = details.strip()

        if _CARD_INFO_RE.match(date_col):
            flush_entry()
            if current_card_last4 is not None:
                sections.append(
                    ParsedVisecaSection(current_card_last4, current_section_entries, None)
                )
            current_card_last4 = details[:4]
            current_section_entries = []
        elif not date_col and amount_chf and _TOTAL_CARTE_RE.search(details):
            flush_entry()
            if current_card_last4 is not None:
                sections.append(
                    ParsedVisecaSection(
                        current_card_last4, current_section_entries, _strip_thousands(amount_chf)
                    )
                )
                current_card_last4 = None
                current_section_entries = []
        elif not date_col and amount_chf and _MONTANT_DU_RE.match(details):
            total_due_chf = _strip_thousands(amount_chf)
        elif _DATE_PATTERN.match(date_col):
            flush_entry()
            last_value_date = value_date.strip()
            last_amount_str = amount_chf
            last_details = details
        elif not date_col and not amount_chf:
            if details and last_value_date is not None:
                last_details = (last_details + " " + details).strip()

    flush_entry()
    if current_card_last4 is not None:
        sections.append(ParsedVisecaSection(current_card_last4, current_section_entries, None))

    return ParsedVisecaStatement(
        preamble_entries=preamble,
        sections=sections,
        total_due_chf=total_due_chf,
    )


def _parse_pdf_bytes(data: bytes) -> ParsedVisecaStatement:
    # camelot requires a file path, not a file-like object
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        return _parse_pdf_path(tmp_path)
    finally:
        os.unlink(tmp_path)


def _parse_pdf_path(filepath: str) -> ParsedVisecaStatement:
    columns = ["100,132,400,472,523"]
    # Page 1 has a taller header; pages 2+ start higher on the page
    first_page_tables = camelot_read_pdf(
        filepath,
        flavor="stream",
        pages="1",
        table_areas=["65,435,585,100"],
        columns=columns,
        split_text=True,
    )
    other_page_tables = camelot_read_pdf(
        filepath,
        flavor="stream",
        pages="2-end",
        table_areas=["65,670,585,100"],
        columns=columns,
        split_text=True,
    )

    all_rows: list[tuple] = []
    for table in [*first_page_tables, *other_page_tables]:
        df = table.df
        if df.columns.size != 6:
            continue
        all_rows.extend(tuple(row) for _, row in df.iterrows())

    return _parse_statement(all_rows)  # type: ignore[arg-type]


def _compute_amount(amount_str: str) -> Decimal:
    normalized = amount_str.replace("'", "").strip()
    if "-" in normalized:
        return Decimal(normalized.replace("-", "").strip())
    return -Decimal(normalized)


def _build_transaction(entry: ParsedVisecaEntry, account_name: str) -> TransactionNormalizeData:
    txn_date = datetime.strptime(entry.value_date, "%d.%m.%y").date()
    amount = _compute_amount(entry.amount_str)
    source_id_hash = hashlib.sha256(
        f"{entry.value_date}:{entry.amount_str}:{entry.details}".encode()
    ).hexdigest()[:16]

    return TransactionNormalizeData(
        transaction_date=txn_date,
        narration=None,
        payee=entry.details or None,
        entity_metadata={"viseca": {}},
        import_metadata=ImportMetadata(source_native_id=f"viseca:{source_id_hash}"),
        postings=[
            PostingNormalizePayload(
                account=account_name,
                units=MoneyValue(amount=amount, symbol="CHF"),
            )
        ],
    )


class VisecaImporter(BaseImporter):
    name = "viseca"
    display_name = "Viseca One Card Statement (PDF)"

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "cards": {
                    "type": "object",
                    "title": "Per-card accounts (map of last-4 digits → account)",
                    "additionalProperties": {"type": "string", "x-resource-type": "account"},
                },
            },
            "additionalProperties": False,
        }

    def get_file_descriptors(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "file",
                "label": "Statement PDF",
                "description": "Viseca One Card monthly statement PDF",
                "accept": ["application/pdf"],
                "required": True,
            }
        ]

    def execute(
        self,
        ctx: ImportContext,
        files: dict[str, bytes],
        config: dict[str, Any],
        settings: Settings | None = None,
    ) -> ImportResult:
        cards_config: dict[str, str] = config.get("cards") or {}

        unique_accounts = set(cards_config.values())
        account_set = ctx.load_account_names()
        for acc in unique_accounts:
            if acc not in account_set:
                raise ValidationError(
                    code="account_not_found",
                    message=f"Account not found: {acc}",
                )

        file_data = files.get("file", b"")
        filename = (files.get("__filename__file__") or b"").decode() or "statement.pdf"

        date_match = _FILENAME_DATE_PATTERN.search(filename)
        stmt_date = (
            datetime.strptime(date_match.group(1), "%Y%m%d").date() if date_match else date.today()
        )

        ctx.ensure_commodity("CHF")

        stmt = _parse_pdf_bytes(file_data)

        missing_cards = sorted(
            {s.card_last4 for s in stmt.sections if s.card_last4 not in cards_config}
        )
        if missing_cards:
            cards_str = ", ".join(f"'{c}'" for c in missing_cards)
            raise ValidationError(
                code="unknown_card",
                message=f"Cards ending in {cards_str} have no account in 'cards' config.",
            )

        first_account = cards_config[stmt.sections[0].card_last4] if stmt.sections else None

        if first_account is not None:
            ctx.create_and_upload_attachment(
                account=first_account,
                attachment_date=stmt_date,
                original_filename=filename,
                media_type="application/pdf",
                document_url=None,
                entity_metadata={"viseca": {}},
                file_data=file_data,
            )

        if first_account is not None:
            for entry in stmt.preamble_entries:
                ctx.create_transaction(_build_transaction(entry, first_account))

        for section in stmt.sections:
            card_account = cards_config[section.card_last4]
            for entry in section.entries:
                ctx.create_transaction(_build_transaction(entry, card_account))

        if stmt.total_due_chf is not None and first_account is not None:
            if len(unique_accounts) == 1:
                ctx.create_balance_assertion(
                    BalanceAssertionCreate(
                        assertion_date=stmt_date,
                        account=first_account,
                        amount=MoneyValue(amount=-stmt.total_due_chf, symbol="CHF"),
                        entity_metadata={"viseca": {}},
                    )
                )
            else:
                for section in stmt.sections:
                    if section.total_chf is not None:
                        ctx.create_balance_assertion(
                            BalanceAssertionCreate(
                                assertion_date=stmt_date,
                                account=cards_config[section.card_last4],
                                amount=MoneyValue(amount=-section.total_chf, symbol="CHF"),
                                entity_metadata={"viseca": {}},
                            )
                        )

        return ctx.result
