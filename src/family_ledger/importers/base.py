from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from family_ledger.api.schemas import (
    AccountCreate,
    BalanceAssertionCreate,
    CommodityCreate,
    PadResponse,
    PriceCreate,
    TransactionNormalizeData,
    TransactionResource,
)
from family_ledger.config import Settings
from family_ledger.importers.result import EntityCounts as EntityCounts  # noqa: F401
from family_ledger.importers.result import EntityErrors as EntityErrors  # noqa: F401
from family_ledger.importers.result import ImportResult as ImportResult  # noqa: F401
from family_ledger.models import Account, Attachment, Commodity
from family_ledger.services import account_balance as account_balance_service
from family_ledger.services import attachments as attachments_service
from family_ledger.services import ledger as ledger_service
from family_ledger.services.errors import ConflictError

_MAX_ERROR_EXAMPLES = 10


class ImportContext:
    """Harness passed to importers: wraps the DB session and accumulates ImportResult.

    Importers call ctx.create_transaction(), ctx.create_balance_assertion(), etc.
    instead of calling ledger_service directly. This guarantees created_resources is
    always populated so the Sheets incremental sync receives the correct resource names.
    """

    def __init__(self, session: Session, settings: Settings | None = None) -> None:
        self._session = session
        self._settings = settings
        self._result = ImportResult()
        self._seen_commodity_symbols: set[str] = set()

    @property
    def session(self) -> Session:
        return self._session

    @property
    def result(self) -> ImportResult:
        return self._result

    def add_warning(self, message: str) -> None:
        self._result.warnings.append(message)

    def _add_entity_error(self, entity_key: str, example: str | None = None) -> None:
        errors = self._result.entities.setdefault(entity_key, EntityCounts()).errors
        errors.count += 1
        if example is not None and len(errors.examples) < _MAX_ERROR_EXAMPLES:
            errors.examples.append(example)

    def _record_created(self, entity_key: str) -> None:
        self._result.entities.setdefault(entity_key, EntityCounts()).created += 1

    def _record_duplicate(self, entity_key: str) -> None:
        self._result.entities.setdefault(entity_key, EntityCounts()).duplicate += 1

    def _track(self, entity_key: str, resource_key: str, creator: Callable[[], Any]) -> str | None:
        """Call creator(), record the result's .name in entities and created_resources.
        Returns the resource name if created, None if duplicate (ConflictError).
        """
        try:
            resource = creator()
            self._result.entities.setdefault(entity_key, EntityCounts()).created += 1
            self._result.created_resources.setdefault(resource_key, []).append(resource.name)
            return resource.name
        except ConflictError:
            self._result.entities.setdefault(entity_key, EntityCounts()).duplicate += 1
            return None

    def create_transaction(self, payload: TransactionNormalizeData) -> bool:
        """Returns True if created, False if duplicate."""
        return (
            self._track(
                "transaction",
                "transactions",
                lambda: ledger_service.create_transaction(self._session, payload),
            )
            is not None
        )

    def create_balance_assertion(self, payload: BalanceAssertionCreate) -> bool:
        """Returns True if created, False if duplicate."""
        return (
            self._track(
                "balance_assertion",
                "balance_assertions",
                lambda: ledger_service.create_balance_assertion(self._session, payload),
            )
            is not None
        )

    def create_account(self, payload: AccountCreate) -> str | None:
        """Returns the resource name if created, None if it already existed."""
        return self._track(
            "account",
            "accounts",
            lambda: ledger_service.create_account(self._session, payload),
        )

    def create_price(self, payload: PriceCreate) -> bool:
        """Returns True if created, False if duplicate."""
        return (
            self._track(
                "price",
                "prices",
                lambda: ledger_service.create_price(self._session, payload),
            )
            is not None
        )

    def create_attachment(
        self,
        *,
        account: str,
        attachment_date: date,
        original_filename: str,
        media_type: str | None,
        document_url: str | None,
        entity_metadata: dict[str, Any],
    ) -> str | None:
        """Returns the attachment resource name if created, None if duplicate."""
        return self._track(
            "attachment",
            "attachments",
            lambda: attachments_service.create_attachment(
                self._session,
                account=account,
                attachment_date=attachment_date,
                original_filename=original_filename,
                media_type=media_type,
                document_url=document_url,
                entity_metadata=entity_metadata,
            ),
        )

    def create_and_upload_attachment(
        self,
        *,
        account: str,
        attachment_date: date,
        original_filename: str,
        media_type: str | None,
        document_url: str | None,
        entity_metadata: dict[str, Any],
        file_data: bytes | None = None,
        title: str | None = None,
    ) -> str | None:
        """Create attachment and upload file data if settings are configured.

        On duplicate, retries the upload if the existing attachment is in a retryable
        failed state. Returns the resource name if created, None if duplicate.
        """
        att_name = self.create_attachment(
            account=account,
            attachment_date=attachment_date,
            original_filename=original_filename,
            media_type=media_type,
            document_url=document_url,
            entity_metadata=entity_metadata,
        )
        if file_data is None or self._settings is None:
            return att_name
        upload_name = att_name
        if upload_name is None:
            att_row = self._session.scalar(
                select(Attachment)
                .options(selectinload(Attachment.account))
                .join(Attachment.account)
                .where(
                    Account.name == account,
                    Attachment.original_filename == original_filename,
                    Attachment.attachment_date == attachment_date,
                )
            )
            if att_row is not None and att_row.status in Attachment.RETRYABLE_STATUSES:
                upload_name = att_row.name
        if upload_name is not None:
            attachments_service.upload_attachment(
                self._session,
                self._settings,
                attachment_name=upload_name,
                file_data=file_data,
                media_type=media_type,
                title=title,
            )
        return att_name

    def paperless_is_configured(self) -> bool:
        """Return True if Paperless-ngx upload is configured in settings."""
        return self._settings is not None and self._settings.paperless_is_configured()

    def load_account_names(self) -> set[str]:
        """Return the set of all account resource names."""
        return set(self._session.scalars(select(Account.name)).all())

    def get_account_by_name(self, account_name: str) -> str | None:
        """Look up an account resource name by its ledger account name (e.g. 'Assets:Cash').

        Returns the resource name (e.g. 'accounts/cash') or None if not found.
        """
        return self._session.scalar(
            select(Account.name).where(Account.account_name == account_name)
        )

    def find_transactions_by_source_id_pattern(
        self,
        pattern: str,
        from_date: date | None = None,
        to_date: date | None = None,
    ) -> list[TransactionResource]:
        """Find transactions whose source_native_ids contain an ID matching the LIKE pattern."""
        return ledger_service.find_transactions_by_source_id_pattern(
            self._session, pattern, from_date, to_date
        )

    def compute_pad(self, account_name: str, pad_date: date) -> PadResponse:
        """Compute PAD balancing transaction amounts for the given account and date."""
        return account_balance_service.compute_pad(self._session, account_name, pad_date)

    def ensure_commodity(self, symbol: str) -> bool:
        """Ensure a commodity exists. Returns True if newly created, False if it already existed."""
        if symbol in self._seen_commodity_symbols:
            self._result.entities.setdefault("commodity", EntityCounts()).duplicate += 1
            return False
        existing = self._session.scalar(select(Commodity.name).where(Commodity.symbol == symbol))
        self._seen_commodity_symbols.add(symbol)
        if existing is not None:
            self._result.entities.setdefault("commodity", EntityCounts()).duplicate += 1
            return False
        commodity = ledger_service.create_commodity(
            self._session, payload=CommodityCreate(symbol=symbol)
        )
        self._result.entities.setdefault("commodity", EntityCounts()).created += 1
        self._result.created_resources.setdefault("commodities", []).append(commodity.name)
        return True


class BaseImporter(ABC):
    name: str
    display_name: str

    def get_schema(self) -> dict[str, Any]:
        return {}

    def get_file_descriptors(self) -> list[dict[str, Any]]:
        return [
            {"name": "file", "label": "File", "description": "", "accept": [], "required": True}
        ]

    @abstractmethod
    def execute(
        self,
        ctx: ImportContext,
        files: dict[str, bytes],
        config: dict[str, Any],
        settings: Settings | None = None,
    ) -> ImportResult: ...
