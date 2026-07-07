from __future__ import annotations

from fastapi import APIRouter, Depends

from family_ledger.api._helpers import DbSession, _call_service
from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import QueryLedgerRequest, QueryLedgerResponse
from family_ledger.db import read_only_transaction
from family_ledger.services.query import executor as query_executor

router = APIRouter(dependencies=[Depends(require_api_token)])


@router.post("/ledger:query", response_model=QueryLedgerResponse)
def query_ledger(request: QueryLedgerRequest, session: DbSession) -> QueryLedgerResponse:
    with read_only_transaction(session):
        return _call_service(query_executor.execute_query, session, request.query)
