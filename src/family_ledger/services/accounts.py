from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.api.schemas import AccountCreate, AccountResource, ListAccountsResponse
from family_ledger.models import Account
from family_ledger.services.errors import NotFoundError, commit_or_raise
from family_ledger.services.identifiers import generate_resource_name
from family_ledger.services.pagination import _run_list_page
from family_ledger.services.validation import resource_name, validate_account_effective_dates


def serialize_account(account: Account) -> AccountResource:
    return AccountResource.model_validate(account)


def list_accounts_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListAccountsResponse:
    accounts, next_page_token = _run_list_page(
        session,
        select(Account).order_by(Account.account_name),
        page_size=page_size,
        page_token=page_token,
    )
    return ListAccountsResponse(
        accounts=[serialize_account(a) for a in accounts],
        next_page_token=next_page_token,
    )


def get_account_by_name(session: Session, account: str) -> AccountResource:
    resource = resource_name("accounts", account)
    account_row = session.scalar(select(Account).where(Account.name == resource))
    if account_row is None:
        raise NotFoundError(code="account_not_found", message="Account not found")
    return serialize_account(account_row)


def update_account(session: Session, account: str, payload: AccountCreate) -> AccountResource:
    resource = resource_name("accounts", account)
    account_row = session.scalar(select(Account).where(Account.name == resource))
    if account_row is None:
        raise NotFoundError(code="account_not_found", message="Account not found")
    validate_account_effective_dates(payload.effective_start_date, payload.effective_end_date)
    account_row.account_name = payload.account_name
    account_row.effective_start_date = payload.effective_start_date
    account_row.effective_end_date = payload.effective_end_date
    account_row.entity_metadata = payload.entity_metadata
    commit_or_raise(session)
    session.refresh(account_row)
    return serialize_account(account_row)


def create_account(session: Session, payload: AccountCreate) -> AccountResource:
    validate_account_effective_dates(payload.effective_start_date, payload.effective_end_date)
    account = Account(
        name=generate_resource_name("accounts", "acc"),
        account_name=payload.account_name,
        effective_start_date=payload.effective_start_date,
        effective_end_date=payload.effective_end_date,
        entity_metadata=payload.entity_metadata,
    )
    session.add(account)
    commit_or_raise(session)
    session.refresh(account)
    return serialize_account(account)
