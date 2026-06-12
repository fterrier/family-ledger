from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pypdfium2 as pdfium

from family_ledger.api.schemas import (
    BalanceAssertionCreate,
    ImportMetadata,
    MoneyValue,
    PostingNormalizePayload,
    TransactionNormalizeData,
)
from family_ledger.importers.base import BaseImporter, ImportContext, ImportResult
from family_ledger.services.errors import ValidationError
from family_ledger_importers.zkb_utils import format_zkb_payee

# Matches a transaction row: date + description + amount + optional valuta + saldo.
# Sign is determined from the saldo difference (running balance), not from this amount field.
_TRANSACTION_LINE_RE = re.compile(
    r"^(\d{2}\.\d{2}\.\d{2}) "  # group 1: transaction date (DD.MM.YY)
    r"(.+?) "  # group 2: description (non-greedy, stops before amount)
    r"[\d']+\.\d{2}"  # amount column (consumed, not captured)
    r"(?: (\d{2}\.\d{2}\.\d{2}))?"  # group 3: optional valuta date
    r" ([\d']+\.\d{2})$"  # group 4: saldo (determines sign via running balance)
)
_IBAN_RE = re.compile(r"IBAN\s+(CH\d{2}[\d\s]{13,22})")
_STATEMENT_DATE_RE = re.compile(r"Auszug per (\d{2}\.\d{2}\.\d{4})")
_CLOSING_BALANCE_RE = re.compile(r"Schlusssaldo zu Ihren (?:Gunsten|Lasten)\s+([\d']+\.\d{2})")
_CURRENCY_RE = re.compile(r"Währung:.*?\(([A-Z]{3})\)")
# Valid Auftrags-Nr refs start with a letter then ≥4 alphanumeric chars (e.g. Z260348427385,
# EK2602105D833A7B). This intentionally excludes TWINT's sequential "Auftrags-Nr. 1" / "2".
_AUFTRAGS_NR_REF_RE = re.compile(r"Auftrags-Nr\.?\s+([A-Z][A-Z0-9]{4,})")
_AUFTRAGS_NR_STRIP_RE = re.compile(r",?\s*Auftrags-Nr\.?\s+\S+")
# Non-transaction lines that should be silently skipped (page headers, footers, summaries).
_SKIP_LINE_RE = re.compile(
    r"^(?:Datum\s+Geschäftsvorgang"
    r"|Additionen\b"
    r"|Schlusssaldo\b"
    r"|Konto-Nr\."
    r"|IBAN\s"
    r"|Produkt\s"
    r"|Lautend auf"
    r"|Zürich,"
    r"|OY\d"
    r"|\d{8}"
    r"|Zürcher Kantonalbank"
    r"|Versand\s"
    r"|\d+/\d+$"
    r"|Auszug per"
    r"|Währung:"
    r"|Wir bitten"
    r"|Beanstandungen"
    r"|Freundliche Grüsse"
    r"|Ohne manuelle"
    r"|Gültig ohne"
    r"|▪"
    r"|Anfangssaldo"
    r"|Total "
    r"|Ihr Konto"
    r"|Kontobewegungen"
    r"|[A-Z]{20,}"  # QR-code garbage (very long all-caps sequences)
    r")"
)


@dataclass(frozen=True)
class ParsedZkbEntry:
    account_iban: str
    transaction_date: date
    value_date: date | None
    effective_date: date
    amount: Decimal  # negative = debit, positive = credit
    currency: str
    description: str  # full joined multi-line description
    ref: str | None  # extracted Auftrags-Nr (Z.../EK... only), or None


@dataclass(frozen=True)
class ParsedZkbStatement:
    entries: list[ParsedZkbEntry]
    account_iban: str
    statement_date: date  # from "Auszug per DD.MM.YYYY"
    closing_amount: Decimal
    closing_currency: str


def _parse_date_2y(s: str) -> date:
    return datetime.strptime(s.strip(), "%d.%m.%y").date()


def _parse_amount(s: str) -> Decimal:
    return Decimal(s.replace("'", "").strip())


def _normalize_iban(raw: str) -> str:
    return re.sub(r"\s", "", raw.strip())


def _extract_ref(description: str) -> str | None:
    m = _AUFTRAGS_NR_REF_RE.search(description)
    return m.group(1) if m else None


def _format_payee(description: str) -> str | None:
    cleaned = _AUFTRAGS_NR_STRIP_RE.sub("", description)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().strip(",")
    return format_zkb_payee([cleaned]) if cleaned else None


def _extract_metadata(text: str) -> tuple[str, date, Decimal, str]:
    iban_m = _IBAN_RE.search(text)
    if not iban_m:
        raise ValidationError(code="invalid_zkb_pdf", message="IBAN not found in ZKB PDF")
    iban = _normalize_iban(iban_m.group(1))

    date_m = _STATEMENT_DATE_RE.search(text)
    if not date_m:
        raise ValidationError(code="invalid_zkb_pdf", message="Statement date not found in ZKB PDF")
    stmt_date = datetime.strptime(date_m.group(1), "%d.%m.%Y").date()

    balance_m = _CLOSING_BALANCE_RE.search(text)
    if not balance_m:
        raise ValidationError(
            code="invalid_zkb_pdf", message="Closing balance not found in ZKB PDF"
        )
    closing_amount = _parse_amount(balance_m.group(1))

    currency_m = _CURRENCY_RE.search(text)
    if not currency_m:
        raise ValidationError(code="invalid_zkb_pdf", message="Currency not found in ZKB PDF")
    currency = currency_m.group(1)

    return iban, stmt_date, closing_amount, currency


def _parse_text_lines(
    lines: list[str],
    iban: str,
    currency: str,
) -> list[ParsedZkbEntry]:
    """Parse raw text lines from all PDF pages into transaction entries.

    Sign (debit/credit) is determined from the running balance difference, not
    from which column (Belastung/Gutschrift) the amount appeared in — this avoids
    needing precise column positions.
    """
    entries: list[ParsedZkbEntry] = []
    prev_saldo: Decimal | None = None

    current_date_str: str | None = None
    current_valuta_str: str | None = None
    current_saldo_str: str | None = None
    current_desc: str = ""

    def flush() -> None:
        nonlocal current_date_str, current_valuta_str, current_saldo_str, current_desc, prev_saldo
        if current_date_str is None or current_saldo_str is None:
            return
        txn_date = _parse_date_2y(current_date_str)
        new_saldo = _parse_amount(current_saldo_str)
        if prev_saldo is None:
            return
        amount = new_saldo - prev_saldo
        prev_saldo = new_saldo
        value_date = _parse_date_2y(current_valuta_str) if current_valuta_str else None
        effective = max(txn_date, value_date) if value_date else txn_date
        entries.append(
            ParsedZkbEntry(
                account_iban=iban,
                transaction_date=txn_date,
                value_date=value_date,
                effective_date=effective,
                amount=amount,
                currency=currency,
                description=current_desc,
                ref=_extract_ref(current_desc),
            )
        )
        current_date_str = None
        current_valuta_str = None
        current_saldo_str = None
        current_desc = ""

    for line in lines:
        line = line.strip()
        if not line:
            continue

        m = _TRANSACTION_LINE_RE.match(line)
        if m:
            date_str, desc, valuta_str, saldo_str = m.group(1), m.group(2), m.group(3), m.group(4)
            if desc == "Saldovortrag":
                # Opening balance row — initialises the running balance, not a transaction.
                flush()
                prev_saldo = _parse_amount(saldo_str)
                continue
            flush()
            current_date_str = date_str
            current_valuta_str = valuta_str
            current_saldo_str = saldo_str
            current_desc = desc
            continue

        if _SKIP_LINE_RE.match(line):
            flush()
            continue

        if current_date_str is not None:
            current_desc = (current_desc + " " + line).strip()

    flush()
    return entries


def _extract_pdf_text(data: bytes) -> str:
    doc = pdfium.PdfDocument(data)
    try:
        pages_text: list[str] = []
        for page in doc:
            textpage = page.get_textpage()
            pages_text.append(textpage.get_text_range())
            textpage.close()
            page.close()
        return "\n".join(pages_text)
    finally:
        doc.close()


def _parse_pdf_bytes(data: bytes) -> ParsedZkbStatement:
    raw_text = _extract_pdf_text(data)
    iban, stmt_date, closing_amount, currency = _extract_metadata(raw_text)
    lines = raw_text.splitlines()
    entries = _parse_text_lines(lines, iban, currency)
    return ParsedZkbStatement(
        entries=entries,
        account_iban=iban,
        statement_date=stmt_date,
        closing_amount=closing_amount,
        closing_currency=currency,
    )


def _validate_account_mappings(
    ctx: ImportContext, config: dict[str, Any], iban: str
) -> dict[str, str]:
    raw_mappings = config.get("account_mappings", {})
    if not isinstance(raw_mappings, dict):
        raise ValidationError(
            code="invalid_config",
            message="ZKB PDF importer requires account_mappings to be a mapping",
        )
    mappings: dict[str, str] = {}
    known_accounts = ctx.load_account_names()
    for k, v in raw_mappings.items():
        if not isinstance(k, str) or not k.strip():
            raise ValidationError(
                code="invalid_config", message="account_mappings keys must be IBANs"
            )
        if not isinstance(v, str) or not v.startswith("accounts/"):
            raise ValidationError(
                code="invalid_config",
                message="account_mappings values must be account resource names",
            )
        if v not in known_accounts:
            raise ValidationError(
                code="account_not_found",
                message=f"Mapped account resource not found: {v}",
            )
        mappings[k.strip()] = v.strip()

    if iban not in mappings:
        raise ValidationError(
            code="missing_account_mapping",
            message=f"Missing account_mappings entry for IBAN: {iban}",
        )
    return mappings


def _compute_source_native_id(entry: ParsedZkbEntry, occurrence: int) -> str:
    content = {
        "date": entry.effective_date.isoformat(),
        "account_iban": entry.account_iban,
        "amount": str(entry.amount),
        "currency": entry.currency,
        "occurrence": occurrence,
    }
    digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode())
    return f"zkb_pdf:fp:{digest.hexdigest()}"


def _build_transaction_payload(
    entry: ParsedZkbEntry,
    account_resource_name: str,
    source_native_id: str,
) -> TransactionNormalizeData:
    metadata: dict[str, Any] = {
        "account_iban": entry.account_iban,
        "transaction_date": entry.transaction_date.isoformat(),
        "effective_date": entry.effective_date.isoformat(),
    }
    if entry.value_date is not None:
        metadata["value_date"] = entry.value_date.isoformat()
    if entry.ref is not None:
        metadata["ref"] = entry.ref
    return TransactionNormalizeData(
        transaction_date=entry.effective_date,
        payee=_format_payee(entry.description),
        narration=None,
        entity_metadata={"zkb_pdf": metadata},
        import_metadata=ImportMetadata(source_native_id=source_native_id),
        postings=[
            PostingNormalizePayload(
                account=account_resource_name,
                units=MoneyValue(amount=entry.amount, symbol=entry.currency),
            )
        ],
    )


class ZkbPdfImporter(BaseImporter):
    name = "zkb_pdf"
    display_name = "ZKB PDF Kontoauszug"

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "account_mappings": {
                    "type": "object",
                    "additionalProperties": {
                        "type": "string",
                        "x-resource-type": "account",
                    },
                    "default": {},
                    "description": "Map ZKB IBAN to internal account resource name.",
                },
            },
            "additionalProperties": False,
        }

    def get_file_descriptors(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "file",
                "label": "ZKB account statement PDF",
                "description": "ZKB Kontoauszug PDF (Privatkonto)",
                "accept": ["application/pdf", ".pdf"],
                "required": True,
            }
        ]

    def execute(
        self,
        ctx: ImportContext,
        files: dict[str, bytes],
        config: dict[str, Any],
        settings: object = None,
    ) -> ImportResult:
        file_data = files.get("file", b"")
        stmt = _parse_pdf_bytes(file_data)

        account_mappings = _validate_account_mappings(ctx, config, stmt.account_iban)

        ctx.ensure_commodity(stmt.closing_currency)

        account_resource = account_mappings[stmt.account_iban]

        occurrence_counter: Counter[tuple[date, str, Decimal, str]] = Counter()
        for entry in stmt.entries:
            if entry.ref is not None:
                source_native_id = f"zkb_pdf:{entry.ref}"
            else:
                key = (entry.effective_date, entry.account_iban, entry.amount, entry.currency)
                count = occurrence_counter[key]
                source_native_id = _compute_source_native_id(entry, count)
                occurrence_counter[key] += 1

            payload = _build_transaction_payload(entry, account_resource, source_native_id)
            ctx.create_transaction(payload)

        ctx.create_balance_assertion(
            BalanceAssertionCreate(
                assertion_date=stmt.statement_date + timedelta(days=1),
                account=account_resource,
                amount=MoneyValue(amount=stmt.closing_amount, symbol=stmt.closing_currency),
                entity_metadata={
                    "zkb_pdf": {
                        "account_iban": stmt.account_iban,
                        "statement_date": stmt.statement_date.isoformat(),
                    }
                },
            )
        )

        return ctx.result
