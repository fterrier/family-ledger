from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import re
import zipfile
from collections import Counter
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from beancount.core.amount import Amount
from beancount.core.data import Balance, Close, Document, Open, Pad, Posting, Price, Transaction
from beancount.core.data import Commodity as CommodityEntry
from beancount.parser import parser
from sqlalchemy import select

from family_ledger.api.schemas import (
    AccountCreate,
    BalanceAssertionCreate,
    ImportMetadata,
    MoneyValue,
    NormalizeMoneyValue,
    NormalizePriceValue,
    PostingNormalizePayload,
    PriceCreate,
    TransactionNormalizeData,
)
from family_ledger.config import Settings
from family_ledger.importers.base import BaseImporter, ImportContext, ImportResult
from family_ledger.models import Account, Attachment
from family_ledger.models import Transaction as TransactionModel
from family_ledger.services import account_balance as account_balance_service
from family_ledger.services import attachments as attachments_service
from family_ledger.services.errors import (
    ConflictError,
    NotFoundError,
    UnavailableError,
    ValidationError,
)

SUPPORTED_ENTRY_TYPES = (Open, Close, CommodityEntry, Transaction, Price, Balance, Pad)
POSTING_COMMENT_CONFIG_KEY = "import_posting_comments_as_narration"
POSTING_LINE_PATTERN = re.compile(r"^\s+[^;\s].*")
_BEANCOUNT_INTERNAL_META_KEYS = frozenset({"filename", "lineno"})


def _extract_zip_flat(data: bytes) -> tuple[dict[str, bytes], set[str]]:
    """Extract a zip into a basename→bytes map, skipping macOS metadata entries.

    Returns (file_map, duplicate_basenames). Duplicates are basenames that appear
    more than once in the archive; only the last entry wins in the map.
    """
    file_map: dict[str, bytes] = {}
    seen: set[str] = set()
    duplicates: set[str] = set()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in zf.namelist():
            parts = name.split("/")
            if "__MACOSX" in parts or any(p.startswith("._") for p in parts if p):
                continue
            basename = os.path.basename(name)
            if basename:
                key = basename.lower()
                if key in seen:
                    duplicates.add(basename)
                seen.add(key)
                file_map[key] = zf.read(name)
    return file_map, duplicates


def _import_document_file(
    ctx: ImportContext,
    settings: Settings,
    *,
    account_row: Account,
    entry_date: object,
    filename: str,
    doc_bytes: bytes,
    media_type: str | None,
    entity_metadata: dict[str, Any],
) -> None:
    from datetime import date as date_type

    assert isinstance(entry_date, date_type)
    att_name = ctx.create_attachment(
        account=account_row.name,
        attachment_date=entry_date,
        original_filename=filename,
        media_type=media_type,
        document_url=None,
        entity_metadata=entity_metadata,
    )
    if att_name is not None:
        attachments_service.upload_attachment(
            ctx.session,
            settings,
            attachment_name=att_name,
            file_data=doc_bytes,
            media_type=media_type,
        )
    else:
        att_row = ctx.session.scalar(
            select(Attachment).where(
                Attachment.account_id == account_row.id,
                Attachment.original_filename == filename,
                Attachment.attachment_date == entry_date,
            )
        )
        if att_row is not None and att_row.status in Attachment.RETRYABLE_STATUSES:
            attachments_service.upload_attachment(
                ctx.session,
                settings,
                attachment_name=att_row.name,
                file_data=doc_bytes,
                media_type=media_type,
            )


def _import_documents(
    ctx: ImportContext,
    settings: Settings | None,
    entries: Sequence[object],
    file_map: dict[str, bytes],
) -> None:
    from datetime import date as date_type

    document_entries = [e for e in entries if isinstance(e, Document)]
    if not document_entries:
        return

    file_backed = [
        e for e in document_entries if "document_url" not in _extract_beancount_meta(e.meta or {})
    ]
    if file_backed and (settings is None or not settings.paperless_is_configured()):
        ctx.add_warning(
            f"Paperless not configured; {len(file_backed)} Document directive(s) skipped"
        )

    for entry in document_entries:
        filename = os.path.basename(entry.filename)
        meta = _extract_beancount_meta(entry.meta or {})
        document_url = meta.pop("document_url", None)
        entity_metadata: dict[str, Any] = {"beancount": meta} if meta else {}

        account_row = ctx.session.scalar(
            select(Account).where(Account.account_name == entry.account)
        )
        if account_row is None:
            ctx._add_entity_error("attachment", f"{entry.account}: account not in ledger")
            continue

        if document_url is not None:
            assert isinstance(entry.date, date_type)
            media_type, _ = mimetypes.guess_type(filename)
            ctx.create_attachment(
                account=account_row.name,
                attachment_date=entry.date,
                original_filename=filename,
                media_type=media_type,
                document_url=document_url,
                entity_metadata=entity_metadata,
            )
            continue

        if settings is None or not settings.paperless_is_configured():
            continue

        doc_bytes = file_map.get(filename.lower())
        if doc_bytes is None:
            ctx._add_entity_error("attachment", f"{filename}: not found in documents archive")
            continue

        media_type, _ = mimetypes.guess_type(filename)
        try:
            _import_document_file(
                ctx,
                settings,
                account_row=account_row,
                entry_date=entry.date,
                filename=filename,
                doc_bytes=doc_bytes,
                media_type=media_type,
                entity_metadata=entity_metadata,
            )
        except (UnavailableError, ValidationError, NotFoundError) as exc:
            ctx._add_entity_error("attachment", f"{filename}: {exc.message}")


def _load_beancount_string(text: str):  # type: ignore[no-untyped-def]
    return parser.parse_string(text)


def _money_value(amount: Amount) -> MoneyValue:
    number = getattr(amount, "number", None)
    currency = getattr(amount, "currency", None)
    if number is None or currency is None:
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def _optional_money_value(amount: Amount | None) -> MoneyValue | NormalizeMoneyValue | None:
    if amount is None:
        return None
    number = getattr(amount, "number", None)
    currency = getattr(amount, "currency", None)
    if not isinstance(currency, str):
        currency = None
    if number is None and currency is None:
        return None
    if number is not None and currency is None:
        return NormalizeMoneyValue(amount=Decimal(str(number)), symbol=None)
    if number is None or currency is None:
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def _optional_explicit_money_value(amount: Amount | None) -> MoneyValue | None:
    value = _optional_money_value(amount)
    if value is None:
        return None
    if isinstance(value, NormalizeMoneyValue):
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return value


def _optional_price_value(amount: Amount | None) -> MoneyValue | NormalizePriceValue | None:
    if amount is None:
        return None
    number = getattr(amount, "number", None)
    currency = getattr(amount, "currency", None)
    if not isinstance(currency, str):
        currency = None
    # Beancount uses a MISSING sentinel for interpolated price amounts.
    if number is None or not isinstance(number, Decimal):
        if currency is not None:
            return NormalizePriceValue(symbol=currency)
        return None
    if currency is None:
        raise ValueError(f"Unsupported Beancount amount value: {amount!r}")
    return MoneyValue(amount=number, symbol=currency)


def _posting_cost_value(posting: Posting) -> MoneyValue | None:
    cost = posting.cost
    if cost is None:
        return None
    number = getattr(cost, "number", None)
    currency = getattr(cost, "currency", None)
    if number is None:
        number = getattr(cost, "number_per", None)
    if number is None:
        number_total = getattr(cost, "number_total", None)
        units_number = getattr(getattr(posting, "units", None), "number", None)
        if number_total is not None and units_number not in (None, 0):
            number = number_total / units_number
    if number is None or currency is None:
        return None
    return MoneyValue(amount=Decimal(str(number)), symbol=currency)


def _extract_beancount_meta(entry_meta: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in entry_meta.items() if k not in _BEANCOUNT_INTERNAL_META_KEYS}


def _posting_comment_by_line(text: str) -> dict[int, str]:
    comments: dict[int, str] = {}
    for index, line in enumerate(text.splitlines(), start=1):
        if not POSTING_LINE_PATTERN.match(line):
            continue
        comment_start = line.find(";")
        if comment_start < 0:
            continue
        comment = line[comment_start + 1 :].strip()
        if comment:
            comments[index] = comment
    return comments


def _posting_payload(
    posting: Posting,
    account_names: dict[str, str],
    narration: str | None = None,
) -> PostingNormalizePayload:
    price = _optional_price_value(cast(Amount | None, posting.price))
    units = _optional_money_value(cast(Amount | None, posting.units))
    return PostingNormalizePayload(
        account=account_names[posting.account],
        units=units,
        narration=narration,
        cost=_posting_cost_value(posting),
        price=price,
    )


def _build_account_creates(entries: Sequence[object]) -> dict[str, AccountCreate]:
    accounts: dict[str, AccountCreate] = {}
    for entry in entries:
        if isinstance(entry, Open):
            accounts[entry.account] = AccountCreate(
                account_name=entry.account,
                effective_start_date=entry.date,
                effective_end_date=None,
            )
    for entry in entries:
        if isinstance(entry, Close) and entry.account in accounts:
            accounts[entry.account] = accounts[entry.account].model_copy(
                update={"effective_end_date": entry.date}
            )
    return accounts


def _discover_commodity_symbols(entries: Sequence[object]) -> list[str]:
    symbols: set[str] = set()
    for entry in entries:
        if isinstance(entry, CommodityEntry):
            symbols.add(entry.currency)
        elif isinstance(entry, Open):
            for currency in getattr(entry, "currencies", ()) or ():
                if isinstance(currency, str):
                    symbols.add(currency)
        elif isinstance(entry, Price):
            symbols.add(entry.currency)
            symbols.add(entry.amount.currency)
        elif isinstance(entry, Balance):
            symbols.add(entry.amount.currency)
        elif isinstance(entry, Transaction):
            for posting in entry.postings:
                for attr in ("units", "cost", "price"):
                    cur = getattr(getattr(posting, attr, None), "currency", None)
                    if isinstance(cur, str):
                        symbols.add(cur)
    return sorted(symbols)


class BeancountImporter(BaseImporter):
    name = "beancount"
    display_name = "Beancount"

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                POSTING_COMMENT_CONFIG_KEY: {
                    "type": "boolean",
                    "default": False,
                    "description": (
                        "Import trailing Beancount posting comments ('; ...') as posting "
                        "narrations. Beancount include directives are not supported."
                    ),
                }
            },
            "additionalProperties": False,
        }

    def get_file_descriptors(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "ledger_file",
                "label": "Ledger file",
                "description": "Plain text .beancount ledger",
                "accept": [".beancount"],
                "required": True,
            },
            {
                "name": "documents_file",
                "label": "Documents archive",
                "description": (
                    "ZIP archive containing the document files referenced by "
                    "Document directives (optional)"
                ),
                "accept": [".zip"],
                "required": False,
            },
        ]

    def execute(
        self,
        ctx: ImportContext,
        files: dict[str, bytes],
        config: dict[str, Any],
        settings: Settings | None = None,
    ) -> ImportResult:
        ledger_bytes = files.get("ledger_file") or files.get("file", b"")
        documents_zip = files.get("documents_file")
        file_map: dict[str, bytes] = {}
        zip_duplicate_basenames: set[str] = set()
        if documents_zip:
            file_map, zip_duplicate_basenames = _extract_zip_flat(documents_zip)

        text = ledger_bytes.decode("utf-8")
        entries, errors, _options_map = _load_beancount_string(text)
        posting_comments = (
            _posting_comment_by_line(text) if config.get(POSTING_COMMENT_CONFIG_KEY) else {}
        )

        if errors:
            messages = "; ".join(str(getattr(e, "message", e)) for e in errors)
            raise ConflictError(
                code="beancount_parse_error",
                message=f"Beancount parse errors: {messages}",
            )

        for name in sorted(zip_duplicate_basenames):
            ctx.add_warning(
                f"duplicate basename in documents archive: {name!r}"
                " — only the last entry will be used"
            )

        # Document entries are always handled (URL-backed ones need no ZIP or Paperless).
        handled_entry_types = SUPPORTED_ENTRY_TYPES + (Document,)
        unrecognized: Counter[str] = Counter()
        for entry in entries:
            if not isinstance(entry, handled_entry_types):
                unrecognized[type(entry).__name__] += 1
        for type_name, count in sorted(unrecognized.items()):
            ctx.add_warning(f"Unrecognized entry type: {type_name} ({count} occurrences)")

        # Accounts
        account_names: dict[str, str] = {}
        for account_name, payload in _build_account_creates(entries).items():
            resource_name = ctx.create_account(payload)
            if resource_name is not None:
                account_names[account_name] = resource_name
            else:
                existing = ctx.session.scalar(
                    select(Account).where(Account.account_name == payload.account_name)
                )
                if existing is not None:
                    account_names[account_name] = existing.name

        # Commodities
        for symbol in _discover_commodity_symbols(entries):
            ctx.ensure_commodity(symbol)

        # Transactions
        occurrence_counter: Counter[tuple[object, ...]] = Counter()
        for entry in entries:
            if not isinstance(entry, Transaction):
                continue
            try:
                posting_payloads: list[PostingNormalizePayload] = []
                for posting in entry.postings:
                    try:
                        posting_meta = getattr(posting, "meta", None) or {}
                        line_number = posting_meta.get("lineno")
                        narration = (
                            posting_comments.get(line_number)
                            if isinstance(line_number, int)
                            else None
                        )
                        posting_payloads.append(_posting_payload(posting, account_names, narration))
                    except ValueError as exc:
                        ctx._add_entity_error(
                            "transaction",
                            f"{entry.date} {entry.payee or ''} {entry.narration or ''}: {exc}",
                        )
                        raise
                beancount_meta = _extract_beancount_meta(getattr(entry, "meta", None) or {})
                entity_metadata: dict[str, Any] = (
                    {"beancount": beancount_meta} if beancount_meta else {}
                )
                raw_native_id = beancount_meta.get("source_native_id")
                ref = beancount_meta.get("ref")
                if raw_native_id is not None:
                    source_native_id = str(raw_native_id)
                elif ref is not None:
                    source_native_id = f"beancount:{ref}"
                else:
                    key: tuple[object, ...] = (entry.date, entry.payee, entry.narration)
                    occurrence = occurrence_counter[key]
                    fp_content = {
                        "date": entry.date.isoformat(),
                        "payee": entry.payee,
                        "narration": entry.narration,
                        "occurrence": occurrence,
                    }
                    digest = hashlib.sha256(
                        json.dumps(fp_content, sort_keys=True, separators=(",", ":")).encode()
                    )
                    source_native_id = f"beancount:fp:{digest.hexdigest()}"
                    occurrence_counter[key] += 1
                payload = TransactionNormalizeData(
                    transaction_date=entry.date,
                    payee=entry.payee,
                    narration=entry.narration,
                    postings=posting_payloads,
                    entity_metadata=entity_metadata,
                    import_metadata=ImportMetadata(source_native_id=source_native_id),
                )
            except ValueError:
                continue
            except InvalidOperation as exc:
                ctx._add_entity_error("transaction", str(exc))
                continue
            ctx.create_transaction(payload)

        # Prices
        for entry in entries:
            if not isinstance(entry, Price):
                continue
            ctx.create_price(
                PriceCreate(
                    price_date=entry.date,
                    base_symbol=entry.currency,
                    quote=_money_value(entry.amount),
                )
            )

        # Balance assertions
        for entry in entries:
            if not isinstance(entry, Balance):
                continue
            ctx.create_balance_assertion(
                BalanceAssertionCreate(
                    assertion_date=entry.date,
                    account=account_names[entry.account],
                    amount=_money_value(entry.amount),
                )
            )

        # Pad directives — phase 2: balance assertions must be in DB first.
        # One synthetic transaction is created per currency per pad directive.
        # Pre-fetch all already-imported pad native_id prefixes in one query.
        imported_pad_prefixes: set[str] = set()
        if any(isinstance(e, Pad) for e in entries):
            for sid in ctx.session.scalars(
                select(TransactionModel.source_native_id).where(
                    TransactionModel.source_native_id.like("beancount:pad:%")
                )
            ).all():
                if sid:
                    imported_pad_prefixes.add(sid.rsplit(":", 1)[0] + ":")

        for entry in entries:
            if not isinstance(entry, Pad):
                continue
            if entry.account not in account_names or entry.source_account not in account_names:
                ctx._add_entity_error(
                    "pad_transaction", f"{entry.date} pad {entry.account}: account not found"
                )
                continue

            native_id_prefix = f"beancount:pad:{entry.account}:{entry.date.isoformat()}:"
            if native_id_prefix in imported_pad_prefixes:
                continue

            try:
                pad_response = account_balance_service.compute_pad(
                    ctx.session, account_names[entry.account], entry.date
                )
            except Exception as exc:
                ctx._add_entity_error("pad_transaction", f"{entry.date} pad {entry.account}: {exc}")
                continue

            for pad_entry in pad_response.entries:
                source_native_id = (
                    f"beancount:pad:{entry.account}:{entry.date.isoformat()}"
                    f":{pad_entry.units.symbol}"
                )
                pad_payload = TransactionNormalizeData(
                    transaction_date=entry.date,
                    narration="Padding entry",
                    entity_metadata={
                        "generated_by": "pad",
                        "source_account": entry.source_account,
                    },
                    import_metadata=ImportMetadata(source_native_id=source_native_id),
                    postings=[
                        PostingNormalizePayload(
                            account=account_names[entry.account],
                            units=MoneyValue(
                                amount=pad_entry.units.amount,
                                symbol=pad_entry.units.symbol,
                            ),
                        ),
                        PostingNormalizePayload(
                            account=account_names[entry.source_account],
                            units=MoneyValue(
                                amount=-pad_entry.units.amount,
                                symbol=pad_entry.units.symbol,
                            ),
                        ),
                    ],
                )
                ctx.create_pad_transaction(pad_payload)

        _import_documents(ctx, settings, entries, file_map)

        return ctx.result
