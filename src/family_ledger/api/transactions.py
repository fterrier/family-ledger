from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, status

from family_ledger.api._helpers import DbSession, _call_service
from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    CreateTransactionRequest,
    DoctorLedgerRequest,
    DoctorLedgerResponse,
    ListTransactionsResponse,
    MergeTransactionRequest,
    NormalizeTransactionRequest,
    NormalizeTransactionResponse,
    TransactionResource,
    UpdateTransactionRequest,
)
from family_ledger.db import read_only_transaction
from family_ledger.services import doctor as doctor_service
from family_ledger.services import transactions as transactions_service

router = APIRouter(dependencies=[Depends(require_api_token)])


@router.get("/transactions", response_model=ListTransactionsResponse)
def list_transactions(
    session: DbSession,
    page_size: int | None = None,
    page_token: str | None = None,
    # TODO: Revisit non-pagination query parameters together with the query design.
    # We may want a more Beancount-like filtering model than the current ad hoc
    # `from_date` / `to_date` / `account` parameters.
    from_date: date | None = None,
    to_date: date | None = None,
    account: str | None = None,
    account_name: str | None = None,
    currency: str | None = None,
    last_import: bool = False,
    order: Literal["asc", "desc"] = "asc",
    convert: str | None = None,
) -> ListTransactionsResponse:
    return _call_service(
        transactions_service.list_transactions_page,
        session,
        page_size=page_size,
        page_token=page_token,
        from_date=from_date,
        to_date=to_date,
        account=account,
        account_name=account_name,
        currency=currency,
        last_import=last_import,
        order=order,
        convert=convert,
    )


@router.post("/ledger:doctor", response_model=DoctorLedgerResponse)
def doctor_ledger(request: DoctorLedgerRequest, session: DbSession) -> DoctorLedgerResponse:
    with read_only_transaction(session):
        return _call_service(doctor_service.doctor_ledger, session, request)


@router.post(
    "/transactions:normalize",
    response_model=NormalizeTransactionResponse,
    response_model_exclude_none=True,
)
def normalize_transaction(
    request: NormalizeTransactionRequest,
    session: DbSession,
) -> NormalizeTransactionResponse:
    return _call_service(transactions_service.normalize_transaction, session, request.transaction)


@router.post(
    "/transactions",
    response_model=TransactionResource,
    status_code=status.HTTP_201_CREATED,
)
def create_transaction(
    request: CreateTransactionRequest, session: DbSession
) -> TransactionResource:
    return _call_service(transactions_service.create_transaction, session, request.transaction)


@router.patch("/transactions/{transaction:path}", response_model=TransactionResource)
def update_transaction(
    transaction: str,
    request: UpdateTransactionRequest,
    session: DbSession,
) -> TransactionResource:
    return _call_service(
        transactions_service.update_transaction,
        session,
        transaction,
        request.transaction,
        request.update_mask,
    )


@router.get("/transactions/{transaction:path}", response_model=TransactionResource)
def get_transaction(
    transaction: str, session: DbSession, convert: str | None = None
) -> TransactionResource:
    return _call_service(
        transactions_service.get_transaction_by_name, session, transaction, convert=convert
    )


@router.delete("/transactions/{transaction:path}", status_code=status.HTTP_204_NO_CONTENT)
def delete_transaction(transaction: str, session: DbSession) -> None:
    _call_service(transactions_service.delete_transaction, session, transaction)


@router.post("/transactions:merge", response_model=TransactionResource)
def merge_transactions(body: MergeTransactionRequest, session: DbSession) -> TransactionResource:
    return _call_service(
        transactions_service.merge_transactions,
        session,
        body.primary_transaction,
        body.secondary_transaction,
    )
