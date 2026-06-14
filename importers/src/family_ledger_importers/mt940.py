from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import mt940

from family_ledger.api.schemas import (
    BalanceAssertionCreate,
    ImportMetadata,
    MoneyValue,
    PostingNormalizePayload,
    TransactionNormalizeData,
)
from family_ledger.importers.base import BaseImporter, ImportContext, ImportResult
from family_ledger.services.errors import ValidationError
from family_ledger_importers.zkb_utils import (
    CONTROL_TOKEN_PATTERN,
    format_zkb_payee,
    normalize_description,
)

FIN_MESSAGE_PATTERN = re.compile(r"\{1:.*?-\}", re.DOTALL)


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


@dataclass(frozen=True)
class ParsedStatementBalance:
    statement_reference: str
    account_iban: str
    statement_number: str
    closing_balance_date: date
    closing_amount: Decimal
    closing_currency: str


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


def _format_payee(lines: list[str], payee_format: str) -> str | None:
    if payee_format == "zkb":
        return format_zkb_payee(lines)
    return normalize_description(lines)


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


def _extract_balance_amount(value: object) -> Decimal | None:
    amount = getattr(value, "amount", None)
    if amount is None:
        return None
    return getattr(amount, "amount", None)


def _extract_balance_currency(value: object) -> str | None:
    amount = getattr(value, "amount", None)
    currency = getattr(amount, "currency", None)
    return currency if isinstance(currency, str) and currency else None


def _extract_description_lines(transaction_data: dict[str, object]) -> list[str]:
    details = transaction_data.get("transaction_details")
    if isinstance(details, str) and details.strip():
        lines = details.splitlines()
        if not lines:
            return []
        first_line = CONTROL_TOKEN_PATTERN.sub("", lines[0], count=1).strip()
        normalized_lines = []
        if first_line:
            normalized_lines.append(first_line)
        normalized_lines.extend(lines[1:])
        return normalized_lines
    extra_details = transaction_data.get("extra_details")
    if isinstance(extra_details, str) and extra_details.strip():
        return [extra_details]
    return []


def _parse_mt940_text(text: str) -> tuple[list[ParsedStatementEntry], list[ParsedStatementBalance]]:
    entries: list[ParsedStatementEntry] = []
    balances: list[ParsedStatementBalance] = []
    for message in _split_mt940_messages(text):
        parsed = mt940.parse(message)
        statement_reference = str(parsed.data.get("transaction_reference") or "").strip()
        account_iban = str(parsed.data.get("account_identification") or "").strip()
        statement_number = _statement_number(parsed.data)
        closing_balance = parsed.data.get("final_closing_balance")
        closing_balance_date = getattr(closing_balance, "date", None)
        closing_amount = _extract_balance_amount(closing_balance)
        closing_currency = _extract_balance_currency(closing_balance)
        if (
            isinstance(closing_balance_date, date)
            and isinstance(closing_amount, Decimal)
            and isinstance(closing_currency, str)
        ):
            balances.append(
                ParsedStatementBalance(
                    statement_reference=statement_reference,
                    account_iban=account_iban,
                    statement_number=statement_number,
                    closing_balance_date=closing_balance_date,
                    closing_amount=closing_amount,
                    closing_currency=closing_currency,
                )
            )

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
    return entries, balances


def _validate_account_mappings(
    ctx: ImportContext, config: dict[str, Any], entries: list[ParsedStatementEntry]
) -> dict[str, str]:
    raw_mappings = config.get("account_mappings", {})
    if not isinstance(raw_mappings, dict):
        raise ValidationError(
            code="invalid_config",
            message="MT940 importer requires account_mappings to be a mapping",
        )
    mappings: dict[str, str] = {}
    known_accounts = ctx.load_account_names()
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


def _compute_entry_source_native_id(
    entry: ParsedStatementEntry, occurrence: int, provider_prefix: str
) -> str:
    content = {
        "date": entry.effective_transaction_date.isoformat(),
        "account_iban": entry.account_iban,
        "amount": str(entry.amount),
        "currency": entry.currency,
        "occurrence": occurrence,
    }
    digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode())
    return f"{provider_prefix}:fp:{digest.hexdigest()}"


def _build_balance_assertion_payload(
    balance: ParsedStatementBalance, account_resource_name: str
) -> BalanceAssertionCreate:
    return BalanceAssertionCreate(
        assertion_date=balance.closing_balance_date + timedelta(days=1),
        account=account_resource_name,
        amount=MoneyValue(amount=balance.closing_amount, symbol=balance.closing_currency),
        entity_metadata={
            "mt940": {
                "statement_reference": balance.statement_reference,
                "account_iban": balance.account_iban,
                "statement_number": balance.statement_number,
                "closing_balance_date": balance.closing_balance_date.isoformat(),
            }
        },
    )


def _select_statement_balances(
    balances: list[ParsedStatementBalance], frequency: str
) -> list[ParsedStatementBalance]:
    if frequency == "none":
        return []
    if frequency == "daily":
        return balances

    selected: list[ParsedStatementBalance] = []
    seen_buckets: set[tuple[object, ...]] = set()
    sorted_balances = sorted(
        balances,
        key=lambda balance: (
            balance.account_iban,
            balance.closing_balance_date,
            balance.statement_number,
            balance.statement_reference,
        ),
    )
    for balance in sorted_balances:
        if frequency == "weekly":
            bucket = (
                balance.account_iban,
                balance.closing_balance_date.isocalendar().year,
                balance.closing_balance_date.isocalendar().week,
            )
        elif frequency == "monthly":
            bucket = (
                balance.account_iban,
                balance.closing_balance_date.year,
                balance.closing_balance_date.month,
            )
        else:
            raise ValidationError(
                code="invalid_config",
                message=f"Unsupported balance_assertion_frequency: {frequency}",
            )
        if bucket in seen_buckets:
            continue
        seen_buckets.add(bucket)
        selected.append(balance)
    return selected


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
                    "default": {},
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
                "balance_assertion_frequency": {
                    "type": "string",
                    "enum": ["none", "daily", "weekly", "monthly"],
                    "default": "none",
                    "description": (
                        "Import MT940 closing balances as balance assertions at the "
                        "selected frequency. Weekly uses the first statement in each ISO week; "
                        "monthly uses the first statement in each month."
                    ),
                },
                "provider_prefix": {
                    "type": "string",
                    "default": "mt940",
                    "description": (
                        "Provider-specific prefix for source_native_id values "
                        "(e.g. 'zkb' for ZKB MT940 files)."
                    ),
                },
            },
            "additionalProperties": False,
        }

    def get_file_descriptors(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "file",
                "label": "MT940 file",
                "description": "MT940 bank statement file",
                "accept": [".sta", ".txt", ".mt940"],
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
        text = files.get("file", b"").decode("utf-8")
        entries, balances = _parse_mt940_text(text)
        if not entries:
            raise ValidationError(code="invalid_mt940", message="No MT940 statements found")

        account_mappings = _validate_account_mappings(ctx, config, entries)
        payee_format = str(config.get("payee_format") or "generic")
        balance_assertion_frequency = str(config.get("balance_assertion_frequency") or "none")
        provider_prefix = str(config.get("provider_prefix") or "mt940")

        for symbol in sorted(
            {entry.currency for entry in entries if entry.currency}
            | {balance.closing_currency for balance in balances if balance.closing_currency}
        ):
            ctx.ensure_commodity(symbol)

        occurrence_counter: Counter[tuple[object, ...]] = Counter()
        for entry in entries:
            if entry.ref is not None:
                source_native_id = f"{provider_prefix}:{entry.ref}"
            else:
                key = (
                    entry.effective_transaction_date,
                    entry.account_iban,
                    entry.amount,
                    entry.currency,
                )
                source_native_id = _compute_entry_source_native_id(
                    entry, occurrence_counter[key], provider_prefix
                )
                occurrence_counter[key] += 1
            payload = _build_transaction_payload(
                entry, account_mappings[entry.account_iban], payee_format, source_native_id
            )
            ctx.create_transaction(payload)

        for balance in _select_statement_balances(balances, balance_assertion_frequency):
            payload = _build_balance_assertion_payload(
                balance, account_mappings[balance.account_iban]
            )
            ctx.create_balance_assertion(payload)

        return ctx.result
