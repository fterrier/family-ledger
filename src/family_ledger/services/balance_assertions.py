from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from family_ledger.api.schemas import (
    BalanceAssertionCreate,
    BalanceAssertionResource,
    ListBalanceAssertionsResponse,
    MoneyValue,
)
from family_ledger.models import BalanceAssertion
from family_ledger.services.errors import NotFoundError, commit_or_raise
from family_ledger.services.identifiers import generate_resource_name
from family_ledger.services.pagination import _run_list_page
from family_ledger.services.validation import resolve_account, resource_name, validate_symbols_exist


def serialize_balance_assertion(assertion: BalanceAssertion) -> BalanceAssertionResource:
    return BalanceAssertionResource(
        name=assertion.name,
        assertion_date=assertion.assertion_date,
        account=assertion.account.name,
        amount=MoneyValue(amount=assertion.amount, symbol=assertion.symbol),
        entity_metadata=assertion.entity_metadata,
    )


def list_balance_assertions_page(
    session: Session, *, page_size: int | None, page_token: str | None
) -> ListBalanceAssertionsResponse:
    assertions, next_page_token = _run_list_page(
        session,
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .order_by(BalanceAssertion.assertion_date, BalanceAssertion.name),
        page_size=page_size,
        page_token=page_token,
    )
    return ListBalanceAssertionsResponse(
        balance_assertions=[serialize_balance_assertion(a) for a in assertions],
        next_page_token=next_page_token,
    )


def create_balance_assertion(
    session: Session, payload: BalanceAssertionCreate
) -> BalanceAssertionResource:
    account = resolve_account(session, payload.account)
    validate_symbols_exist(session, {payload.amount.symbol})
    assertion = BalanceAssertion(
        name=generate_resource_name("balanceAssertions", "bal"),
        assertion_date=payload.assertion_date,
        account=account,
        amount=payload.amount.amount,
        symbol=payload.amount.symbol,
        entity_metadata=payload.entity_metadata,
    )
    session.add(assertion)
    commit_or_raise(session)
    session.refresh(assertion)
    persisted = session.scalar(
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .where(BalanceAssertion.id == assertion.id)
    )
    assert persisted is not None
    return serialize_balance_assertion(persisted)


def update_balance_assertion(
    session: Session, balance_assertion: str, payload: BalanceAssertionCreate
) -> BalanceAssertionResource:
    resource = resource_name("balanceAssertions", balance_assertion)
    assertion = session.scalar(
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .where(BalanceAssertion.name == resource)
    )
    if assertion is None:
        raise NotFoundError(
            code="balance_assertion_not_found", message="Balance assertion not found"
        )
    account = resolve_account(session, payload.account)
    validate_symbols_exist(session, {payload.amount.symbol})
    assertion.assertion_date = payload.assertion_date
    assertion.account = account
    assertion.amount = payload.amount.amount
    assertion.symbol = payload.amount.symbol
    assertion.entity_metadata = payload.entity_metadata
    commit_or_raise(session)
    session.refresh(assertion)
    return serialize_balance_assertion(assertion)


def delete_balance_assertion(session: Session, balance_assertion: str) -> None:
    resource = resource_name("balanceAssertions", balance_assertion)
    assertion = session.scalar(select(BalanceAssertion).where(BalanceAssertion.name == resource))
    if assertion is None:
        raise NotFoundError(
            code="balance_assertion_not_found", message="Balance assertion not found"
        )
    session.delete(assertion)
    commit_or_raise(session)


def get_balance_assertion_by_name(
    session: Session, balance_assertion: str
) -> BalanceAssertionResource:
    resource = resource_name("balanceAssertions", balance_assertion)
    assertion = session.scalar(
        select(BalanceAssertion)
        .options(selectinload(BalanceAssertion.account))
        .where(BalanceAssertion.name == resource)
    )
    if assertion is None:
        raise NotFoundError(
            code="balance_assertion_not_found", message="Balance assertion not found"
        )
    return serialize_balance_assertion(assertion)
