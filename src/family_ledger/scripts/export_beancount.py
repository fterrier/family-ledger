from __future__ import annotations

import argparse
import logging
import re
import sys
from collections.abc import Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from family_ledger.config import LedgerConfig, Settings, get_ledger_config, get_settings
from family_ledger.db import SessionLocal
from family_ledger.models import (
    Account,
    Attachment,
    BalanceAssertion,
    Commodity,
    Posting,
    Price,
    Transaction,
)
from family_ledger.services import paperless as paperless_service
from family_ledger.services.errors import UnavailableError

_log = logging.getLogger(__name__)

_META_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_COMMODITY_DATE = "2000-01-01"


def _d(value: Decimal) -> str:
    # Force fixed-point notation — Beancount rejects scientific notation like 1.5E-7.
    return format(value, "f")


def _meta_value(value: Any) -> str:
    escaped = str(value).replace('"', '\\"')
    return f'"{escaped}"'


def _meta_lines(source_native_id: str | None, meta: dict[str, Any]) -> list[str]:
    lines = []
    if source_native_id is not None:
        lines.append(f'  source_native_id: "{source_native_id}"')
    for key, value in meta.items():
        if key == "source_native_id":
            continue
        if not _META_KEY_RE.match(key):
            continue
        lines.append(f"  {key}: {_meta_value(value)}")
    return lines


def _format_posting(posting: Posting, account_col_width: int) -> str:
    account_name = posting.account.account_name
    padding = " " * (account_col_width - len(account_name))
    amount_str = f"{_d(posting.units_amount)} {posting.units_symbol}"
    if posting.cost_per_unit is not None:
        amount_str += f" {{{_d(posting.cost_per_unit)} {posting.cost_symbol}}}"
    if posting.price_per_unit is not None:
        amount_str += f" @ {_d(posting.price_per_unit)} {posting.price_symbol}"
    line = f"  {account_name}{padding}  {amount_str}"
    if posting.narration:
        line += f" ; {posting.narration}"
    return line


def _format_document(attachment: Attachment, documents_dir: Path | None = None) -> str:
    account_name = attachment.account.account_name
    date_str = attachment.attachment_date.isoformat()
    if documents_dir is not None:
        raw_path = str(documents_dir / attachment.original_filename)
    else:
        raw_path = attachment.original_filename
    escaped = raw_path.replace('"', '\\"')
    header = f'{date_str} document {account_name} "{escaped}"'

    entity_meta = attachment.entity_metadata or {}
    top_level = {k: v for k, v in entity_meta.items() if k != "beancount" and _META_KEY_RE.match(k)}
    beancount = entity_meta.get("beancount", {})
    merged = {**top_level, **beancount}

    meta: list[str] = []
    if attachment.document_url is not None:
        meta.append(f'  document_url: "{attachment.document_url}"')
    meta.extend(_meta_lines(None, merged))

    return "\n".join([header, *meta])


def _format_transaction(tx: Transaction) -> str:
    date_str = tx.transaction_date.isoformat()
    if tx.payee is not None:
        header = f'{date_str} * "{tx.payee}" "{tx.narration or ""}"'
    elif tx.narration is not None:
        header = f'{date_str} * "{tx.narration}"'
    else:
        header = f'{date_str} * ""'

    # Collect metadata: top-level entity_metadata keys (e.g. generated_by for pad
    # transactions), then keys under entity_metadata["beancount"], with beancount
    # values winning on conflicts.
    entity_meta = tx.entity_metadata or {}
    top_level = {k: v for k, v in entity_meta.items() if k != "beancount" and _META_KEY_RE.match(k)}
    beancount = entity_meta.get("beancount", {})
    merged = {**top_level, **beancount}

    meta = _meta_lines(tx.source_native_id, merged)

    postings = tx.postings
    account_col_width = max((len(p.account.account_name) for p in postings), default=0)
    posting_lines = [_format_posting(p, account_col_width) for p in postings]

    return "\n".join([header, *meta, *posting_lines])


def _sync_documents(
    attachments: Sequence[Attachment],
    documents_dir: Path,
    settings: Settings | None,
    *,
    force: bool = False,
) -> None:
    documents_dir.mkdir(parents=True, exist_ok=True)
    can_download = settings is not None and settings.paperless_is_configured()
    for att in attachments:
        dest = documents_dir / att.original_filename
        if dest.exists() and not force:
            continue
        if can_download and att.document_url is not None:
            try:
                content = paperless_service.download_document(settings, att.document_url)  # type: ignore[arg-type]
                dest.write_bytes(content)
            except UnavailableError as exc:
                _log.warning("skipping %s: %s", att.original_filename, exc)


def export_beancount(
    session: Session,
    config: LedgerConfig,
    settings: Settings | None = None,
    *,
    documents_dir: Path | None = None,
    force_download: bool = False,
) -> str:
    commodities = session.scalars(select(Commodity).order_by(Commodity.symbol)).all()

    accounts = session.scalars(
        select(Account).order_by(Account.effective_start_date, Account.account_name)
    ).all()

    prices = session.scalars(select(Price).order_by(Price.price_date, Price.base_symbol)).all()

    transactions = session.scalars(
        select(Transaction)
        .options(selectinload(Transaction.postings).selectinload(Posting.account))
        .order_by(Transaction.transaction_date, Transaction.name)
    ).all()

    balance_assertions = session.scalars(
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .order_by(BalanceAssertion.assertion_date, BalanceAssertion.name)
    ).all()

    attachments = session.scalars(
        select(Attachment)
        .options(selectinload(Attachment.account))
        .where(Attachment.status == "stored")
        .order_by(Attachment.attachment_date, Attachment.name)
    ).all()

    if documents_dir is not None:
        _sync_documents(attachments, documents_dir, settings, force=force_download)

    sections: list[str] = []

    options = [f'option "operating_currency" "{config.default_currency}"']
    sections.append("\n".join(options))

    if commodities:
        sections.append("\n".join(f"{_COMMODITY_DATE} commodity {c.symbol}" for c in commodities))

    open_lines = [f"{a.effective_start_date.isoformat()} open {a.account_name}" for a in accounts]
    close_accounts = sorted(
        (a for a in accounts if a.effective_end_date is not None),
        key=lambda a: (a.effective_end_date, a.account_name),
    )
    close_lines = [
        f"{a.effective_end_date.isoformat()} close {a.account_name}"  # type: ignore[union-attr]
        for a in close_accounts
    ]
    if open_lines or close_lines:
        sections.append("\n".join(open_lines + close_lines))

    if prices:
        sections.append(
            "\n".join(
                f"{p.price_date.isoformat()} price {p.base_symbol}"
                f" {_d(p.price_per_unit)} {p.quote_symbol}"
                for p in prices
            )
        )

    if transactions:
        sections.append("\n\n".join(_format_transaction(tx) for tx in transactions))

    if balance_assertions:
        sections.append(
            "\n".join(
                f"{ba.assertion_date.isoformat()} balance"
                f" {ba.account.account_name} {_d(ba.amount)} {ba.symbol}"
                for ba in balance_assertions
            )
        )

    if attachments:
        sections.append("\n\n".join(_format_document(att, documents_dir) for att in attachments))

    return "\n\n".join(sections) + "\n"


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")
    parser = argparse.ArgumentParser(description="Export the ledger to Beancount format.")
    parser.add_argument("--output", default=None, help="Output file path (default: stdout)")
    parser.add_argument(
        "--documents-dir",
        default=None,
        help="Directory to download and reference documents (overrides ledger.yaml documents_dir)",
    )
    parser.add_argument(
        "--force-download",
        action="store_true",
        default=False,
        help="Re-download documents even if they already exist in the documents directory",
    )
    args = parser.parse_args()

    config = get_ledger_config()
    settings = get_settings()
    documents_dir = Path(args.documents_dir) if args.documents_dir else None
    with SessionLocal() as session:
        content = export_beancount(
            session,
            config,
            settings,
            documents_dir=documents_dir,
            force_download=args.force_download,
        )

    if args.output:
        Path(args.output).write_text(content, encoding="utf-8")
    else:
        sys.stdout.write(content)
        sys.stdout.flush()


if __name__ == "__main__":
    main()
