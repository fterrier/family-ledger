from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from starlette.datastructures import UploadFile

from family_ledger.api._helpers import DbSession, _call_service
from family_ledger.api.auth import require_api_token
from family_ledger.api.schemas import (
    ImporterResource,
    ImportResponse,
    ListImportersResponse,
    UpdateImporterRequest,
)
from family_ledger.config import Settings, get_settings
from family_ledger.services import importer as importer_service

router = APIRouter(dependencies=[Depends(require_api_token)])

AppSettings = Annotated[Settings, Depends(get_settings)]


@router.get("/importers", response_model=ListImportersResponse)
def list_importers(session: DbSession) -> ListImportersResponse:
    return _call_service(importer_service.list_importers, session)


@router.patch("/importers/{importer:path}", response_model=ImporterResource)
def update_importer(
    importer: str,
    request: UpdateImporterRequest,
    session: DbSession,
) -> ImporterResource:
    plugin_name = importer.removeprefix("importers/")
    return _call_service(
        importer_service.update_importer_config,
        session,
        plugin_name,
        request.importer.config,
    )


@router.post("/importers/{importer:path}:import", response_model=ImportResponse)
async def run_import(
    importer: str,
    session: DbSession,
    settings: AppSettings,
    request: Request,
) -> ImportResponse:
    plugin_name = importer.removeprefix("importers/")
    form = await request.form()

    config_override_raw = form.get("config_override")

    files: dict[str, bytes] = {}
    for key, value in form.multi_items():
        if isinstance(value, UploadFile):
            files[key] = await value.read()
            if value.filename:
                files[f"__filename__{key}__"] = value.filename.encode()

    result = _call_service(
        importer_service.execute_import,
        session,
        plugin_name,
        files,
        str(config_override_raw) if config_override_raw is not None else None,
        settings,
    )
    return ImportResponse(result=result)
