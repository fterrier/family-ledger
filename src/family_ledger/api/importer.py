from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    ImporterResource,
    ImportResponse,
    ListImportersResponse,
    UpdateImporterRequest,
)
from family_ledger.db import get_db_session
from family_ledger.services import importer as importer_service
from family_ledger.services.errors import (
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)

router = APIRouter(dependencies=[Depends(require_api_token)])

DbSession = Annotated[Session, Depends(get_db_session)]


def _translate_service_error(error: ServiceError) -> HTTPException:
    if isinstance(error, ValidationError):
        status_code = status.HTTP_400_BAD_REQUEST
    elif isinstance(error, NotFoundError):
        status_code = status.HTTP_404_NOT_FOUND
    elif isinstance(error, ConflictError):
        status_code = status.HTTP_409_CONFLICT
    else:
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    return HTTPException(
        status_code=status_code,
        detail={"code": error.code, "message": error.message},
    )


def _call_service(fn, *args, **kwargs):  # type: ignore[no-untyped-def]
    try:
        return fn(*args, **kwargs)
    except ServiceError as error:
        raise _translate_service_error(error) from error


@router.get("/importers", response_model=ListImportersResponse)
def list_importers(session: DbSession) -> ListImportersResponse:
    return _call_service(importer_service.list_importers, session)


@router.patch("/importers/{importer:path}", response_model=ImporterResource)
def update_importer(
    importer: str,
    request: UpdateImporterRequest,
    session: DbSession,
) -> ImporterResource:
    return _call_service(
        importer_service.update_importer_config,
        session,
        importer,
        request.importer.config,
    )


@router.post("/importers/{importer:path}:import", response_model=ImportResponse)
def run_import(
    importer: str,
    session: DbSession,
    file: UploadFile,
    config_override: Annotated[str | None, Form()] = None,
) -> ImportResponse:
    override: dict | None = None
    if config_override is not None:
        try:
            parsed = json.loads(config_override)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "invalid_config_override",
                    "message": "config_override is not valid JSON",
                },
            ) from exc
        if not isinstance(parsed, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "invalid_config_override",
                    "message": "config_override must be a JSON object",
                },
            )
        override = parsed

    file_data = file.file.read()
    result = _call_service(importer_service.execute_import, session, importer, file_data, override)
    return ImportResponse(result=result)
