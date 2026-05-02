from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

import mt940
from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    CommodityCreate,
    ImportMetadata,
    MoneyValue,
    PostingNormalizePayload,
    TransactionNormalizeData,
)
from family_ledger.importers.base import BaseImporter, EntityCounts, ImportResult
from family_ledger.models import Account, Commodity
from family_ledger.services import ledger as ledger_service
from family_ledger.services.errors import ConflictError, ValidationError

FIN_MESSAGE_PATTERN = re.compile(r"\{1:.*?-\}", re.DOTALL)
CONTROL_TOKEN_PATTERN = re.compile(r"\?[A-Z0-9]{1,4}:[^\s]*")


@dataclass(frozen=True)
class ParsedStatementEntry:
    statement_reference: str
    account_iban: str
    statement_number: str
    currency: str
    value_date: date
    entry_date: date | None
    effective_transaction_date: date
    amount: Decimal
    transaction_code: str | None
    ref: str | None
    description_lines: list[str]


def _split_mt940_messages(text: str) -> list[str]:
    messages = [match.group(0) for match in FIN_MESSAGE_PATTERN.finditer(text)]
    return messages or [text]


def _normalize_ref(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized or normalized.upper() == "NONREF":
        return None
    return normalized


def _normalize_for_dedupe(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def _clean_description_line(line: str) -> str:
    normalized = CONTROL_TOKEN_PATTERN.sub(" ", line)
    normalized = re.sub(r"\s+", " ", normalized).strip(" ,")
    return normalized.strip()


def _dedupe_description_lines(lines: list[str]) -> list[str]:
    deduped: list[str] = []
    deduped_norms: list[str] = []
    for raw_line in lines:
        line = _clean_description_line(raw_line)
        if not line:
            continue
        norm = _normalize_for_dedupe(line)
        if not norm:
            continue
        replaced = False
        skip = False
        for index, existing_norm in enumerate(deduped_norms):
            if norm == existing_norm or norm in existing_norm:
                skip = True
                break
            if existing_norm in norm:
                deduped[index] = line
                deduped_norms[index] = norm
                replaced = True
                break
        if skip:
            continue
        if not replaced:
            deduped.append(line)
            deduped_norms.append(norm)
    return deduped


def _normalize_description(lines: list[str]) -> str | None:
    deduped = _dedupe_description_lines(lines)
    if not deduped:
        return None
    return " ".join(deduped).strip() or None


def _format_zkb_payee(lines: list[str]) -> str | None:
    deduped = _dedupe_description_lines(lines)
    if not deduped:
        return None
    first_line = deduped[0]
    descriptor = first_line.strip()
    body_parts = []
    if "," in first_line:
        descriptor, first_body = first_line.split(",", 1)
        descriptor = descriptor.strip()
        if first_body.strip():
            body_parts.append(first_body.strip())
    elif len(deduped) > 1:
        body_parts.extend(deduped[1:])
    else:
        return " ".join(deduped).strip() or None
    if "," not in first_line:
        body_parts = deduped[1:]
    else:
        body_parts.extend(deduped[1:])
    body = " ".join(part for part in body_parts if part).strip()
    if not descriptor or not body:
        return " ".join(deduped).strip() or None
    return body + " - " + descriptor


def _format_payee(lines: list[str], payee_format: str) -> str | None:
    if payee_format == "zkb":
        return _format_zkb_payee(lines)
    return _normalize_description(lines)


def _coerce_date(value: object) -> date:
    if isinstance(value, date):
        return value
    try:
        return date(int(value.year), int(value.month), int(value.day))  # type: ignore[reportAttributeAccessIssue]
    except (AttributeError, TypeError, ValueError):
        pass
    raise ValidationError(code="invalid_mt940", message=f"Unsupported MT940 date value: {value!r}")


def _extract_transaction_code(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if value.startswith("N") and len(value) > 1:
        return value[1:]
    return value


def _statement_number(data: dict[str, object]) -> str:
    statement_number = str(data.get("statement_number") or "").strip()
    sequence_number = str(data.get("sequence_number") or "").strip()
    if statement_number and sequence_number:
        return statement_number + "/" + sequence_number
    return statement_number or sequence_number


def _extract_ref(data: dict[str, object]) -> str | None:
    bank_reference = data.get("bank_reference")
    if isinstance(bank_reference, str):
        normalized = _normalize_ref(bank_reference)
        if normalized is not None:
            return normalized
    customer_reference = data.get("customer_reference")
    if isinstance(customer_reference, str):
        return _normalize_ref(customer_reference)
    return None


def _extract_currency(
    statement_data: dict[str, object], transaction_data: dict[str, object]
) -> str:
    amount = transaction_data.get("amount")
    amount_currency = getattr(amount, "currency", None)
    if isinstance(amount_currency, str) and amount_currency:
        return amount_currency
    for key in ("final_opening_balance", "final_closing_balance", "available_balance"):
        balance = statement_data.get(key)
        balance_currency = getattr(balance, "currency", None)
        if isinstance(balance_currency, str) and balance_currency:
            return balance_currency
    raise ValidationError(code="invalid_mt940", message="MT940 transaction currency is missing")


def _extract_description_lines(transaction_data: dict[str, object]) -> list[str]:
    details = transaction_data.get("transaction_details")
    if isinstance(details, str) and details.strip():
        return details.splitlines()
    extra_details = transaction_data.get("extra_details")
    if isinstance(extra_details, str) and extra_details.strip():
        return [extra_details]
    return []


def _parse_mt940_text(text: str) -> list[ParsedStatementEntry]:
    entries: list[ParsedStatementEntry] = []
    for message in _split_mt940_messages(text):
        parsed = mt940.parse(message)
        statement_reference = str(parsed.data.get("transaction_reference") or "").strip()
        account_iban = str(parsed.data.get("account_identification") or "").strip()
        statement_number = _statement_number(parsed.data)

        for transaction in parsed:
            transaction_data = transaction.data
            value_date = _coerce_date(transaction_data.get("date"))
            raw_entry_date = transaction_data.get("entry_date")
            entry_date = _coerce_date(raw_entry_date) if raw_entry_date is not None else None
            effective_transaction_date = (
                max(value_date, entry_date) if entry_date is not None else value_date
            )
            amount = transaction_data.get("amount")
            amount_value = getattr(amount, "amount", None)
            if not isinstance(amount_value, Decimal):
                raise ValidationError(
                    code="invalid_mt940", message=f"Unsupported MT940 amount value: {amount!r}"
                )
            entries.append(
                ParsedStatementEntry(
                    statement_reference=statement_reference,
                    account_iban=account_iban,
                    statement_number=statement_number,
                    currency=_extract_currency(parsed.data, transaction_data),
                    value_date=value_date,
                    entry_date=entry_date,
                    effective_transaction_date=effective_transaction_date,
                    amount=amount_value,
                    transaction_code=_extract_transaction_code(transaction_data.get("id")),
                    ref=_extract_ref(transaction_data),
                    description_lines=_extract_description_lines(transaction_data),
                )
            )
    return entries


def _load_account_name_set(session: Session) -> set[str]:
    return set(session.scalars(select(Account.name)).all())


def _validate_account_mappings(
    session: Session, config: dict[str, Any], entries: list[ParsedStatementEntry]
) -> dict[str, str]:
    raw_mappings = config.get("account_mappings")
    if not isinstance(raw_mappings, dict):
        raise ValidationError(
            code="invalid_config",
            message="MT940 importer requires account_mappings to be a mapping",
        )
    mappings: dict[str, str] = {}
    known_accounts = _load_account_name_set(session)
    for iban, resource_name in raw_mappings.items():
        if not isinstance(iban, str) or not iban.strip():
            raise ValidationError(code="invalid_config", message="MT940 mapping keys must be IBANs")
        if not isinstance(resource_name, str) or not resource_name.startswith("accounts/"):
            raise ValidationError(
                code="invalid_config",
                message="MT940 mapping values must be account resource names",
            )
        if resource_name not in known_accounts:
            raise ValidationError(
                code="account_not_found",
                message=f"Mapped MT940 account resource not found: {resource_name}",
            )
        mappings[iban.strip()] = resource_name.strip()

    required_ibans = {entry.account_iban for entry in entries}
    missing_ibans = sorted(iban for iban in required_ibans if iban and iban not in mappings)
    if missing_ibans:
        raise ValidationError(
            code="missing_account_mapping",
            message=f"Missing MT940 account_mappings for: {', '.join(missing_ibans)}",
        )
    return mappings


def _ensure_commodity(session: Session, symbol: str) -> bool:
    existing = session.scalar(select(Commodity.name).where(Commodity.symbol == symbol))
    if existing is not None:
        return False
    ledger_service.create_commodity(session, payload=CommodityCreate(symbol=symbol))
    return True


def _compute_entry_source_native_id(entry: ParsedStatementEntry, occurrence: int) -> str:
    content = {
        "date": entry.effective_transaction_date.isoformat(),
        "account_iban": entry.account_iban,
        "amount": str(entry.amount),
        "currency": entry.currency,
        "occurrence": occurrence,
    }
    digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode())
    return f"mt940:fp:{digest.hexdigest()}"


def _build_transaction_payload(
    entry: ParsedStatementEntry,
    account_resource_name: str,
    payee_format: str,
    source_native_id: str,
) -> TransactionNormalizeData:
    payee = _format_payee(entry.description_lines, payee_format)
    metadata: dict[str, Any] = {
        "statement_reference": entry.statement_reference,
        "account_iban": entry.account_iban,
        "statement_number": entry.statement_number,
        "value_date": entry.value_date.isoformat(),
        "entry_date": entry.entry_date.isoformat() if entry.entry_date is not None else None,
        "effective_transaction_date": entry.effective_transaction_date.isoformat(),
    }
    if entry.ref is not None:
        metadata["ref"] = entry.ref
    if entry.transaction_code is not None:
        metadata["transaction_code"] = entry.transaction_code
    return TransactionNormalizeData(
        transaction_date=entry.effective_transaction_date,
        payee=payee,
        narration=None,
        entity_metadata={"mt940": metadata},
        import_metadata=ImportMetadata(source_native_id=source_native_id),
        postings=[
            PostingNormalizePayload(
                account=account_resource_name,
                units=MoneyValue(amount=entry.amount, symbol=entry.currency),
            )
        ],
    )


class Mt940Importer(BaseImporter):
    name = "mt940"
    display_name = "MT940"

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
                    "description": "Map MT940 :25: IBAN values to internal account resource names.",
                },
                "payee_format": {
                    "type": "string",
                    "enum": ["generic", "zkb"],
                    "default": "generic",
                    "description": (
                        "Optional payee formatting style. 'zkb' applies structural "
                        "comma-based reordering for ZKB-style descriptions."
                    ),
                },
            },
            "required": ["account_mappings"],
            "additionalProperties": False,
        }

    def execute(self, session: Session, file_data: bytes, config: dict[str, Any]) -> ImportResult:
        text = file_data.decode("utf-8")
        entries = _parse_mt940_text(text)
        if not entries:
            raise ValidationError(code="invalid_mt940", message="No MT940 statements found")

        account_mappings = _validate_account_mappings(session, config, entries)
        payee_format = str(config.get("payee_format") or "generic")
        result = ImportResult()

        for symbol in sorted({entry.currency for entry in entries if entry.currency}):
            if _ensure_commodity(session, symbol):
                result.entities.setdefault("commodity", EntityCounts()).created += 1
            else:
                result.entities.setdefault("commodity", EntityCounts()).duplicate += 1

        occurrence_counter: Counter[tuple[object, ...]] = Counter()
        for entry in entries:
            if entry.ref is not None:
                source_native_id = f"mt940:{entry.ref}"
            else:
                key = (
                    entry.effective_transaction_date,
                    entry.account_iban,
                    entry.amount,
                    entry.currency,
                )
                source_native_id = _compute_entry_source_native_id(entry, occurrence_counter[key])
                occurrence_counter[key] += 1
            payload = _build_transaction_payload(
                entry, account_mappings[entry.account_iban], payee_format, source_native_id
            )
            try:
                ledger_service.create_transaction(session, payload)
                result.entities.setdefault("transaction", EntityCounts()).created += 1
            except ConflictError:
                result.entities.setdefault("transaction", EntityCounts()).duplicate += 1

        return result
