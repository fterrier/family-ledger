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
    ImportMetadata,
    MoneyValue,
    PostingNormalizePayload,
    TransactionNormalizeData,
)
from family_ledger.config import Settings
from family_ledger.importers.base import BaseImporter, ImportContext, ImportResult
from family_ledger.services import attachments as attachment_service
from family_ledger.services.errors import ValidationError
from family_ledger_importers.utils import load_account_name_set

_DATE_PATTERN = re.compile(r"^\d\d\.\d\d\.\d\d$")
_FILENAME_DATE_PATTERN = re.compile(r"visebpp_(\d{8})_")


@dataclass(frozen=True)
class ParsedVisecaEntry:
    value_date: str
    amount_str: str  # raw amount; trailing " -" = credit, "'" = thousand separator
    details: str


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


def _parse_pdf_bytes(data: bytes) -> list[ParsedVisecaEntry]:
    # camelot requires a file path, not a file-like object
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        return _parse_pdf_path(tmp_path)
    finally:
        os.unlink(tmp_path)


def _parse_pdf_path(filepath: str) -> list[ParsedVisecaEntry]:
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

    entries: list[ParsedVisecaEntry] = []
    for table in [*first_page_tables, *other_page_tables]:
        df = table.df
        if df.columns.size != 6:
            continue
        rows = [tuple(row) for _, row in df.iterrows()]
        entries.extend(_parse_rows(rows))  # type: ignore[arg-type]

    return entries


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
        narration=entry.details or None,
        payee=None,
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
            "required": ["account"],
            "properties": {
                "account": {
                    "type": "string",
                    "title": "Cumulus Visa account resource name",
                    "x-resource-type": "account",
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
        account_name = config.get("account")
        if not account_name:
            raise ValidationError(code="invalid_config", message="'account' is required")

        if account_name not in load_account_name_set(ctx.session):
            raise ValidationError(
                code="account_not_found",
                message=f"Account not found: {account_name}",
            )

        file_data = files.get("file", b"")
        filename = (files.get("__filename__file__") or b"").decode() or "statement.pdf"

        date_match = _FILENAME_DATE_PATTERN.search(filename)
        stmt_date = (
            datetime.strptime(date_match.group(1), "%Y%m%d").date() if date_match else date.today()
        )

        ctx.ensure_commodity("CHF")

        if settings is not None:
            att_name = ctx.create_attachment(
                account=account_name,
                attachment_date=stmt_date,
                original_filename=filename,
                media_type="application/pdf",
                document_url=None,
                entity_metadata={"viseca": {}},
            )
            if att_name is not None:
                attachment_service.upload_attachment(
                    ctx.session,
                    settings,
                    attachment_name=att_name,
                    file_data=file_data,
                    media_type="application/pdf",
                )

        entries = _parse_pdf_bytes(file_data)
        for entry in entries:
            ctx.create_transaction(_build_transaction(entry, account_name))

        return ctx.result
