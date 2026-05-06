from __future__ import annotations

from typing import Any

from sqlalchemy import Text
from sqlalchemy.orm import Mapped, mapped_column

from family_ledger.models.base import Base
from family_ledger.models.ledger import json_type


class Importer(Base):
    __tablename__ = "importers"

    plugin_name: Mapped[str] = mapped_column(Text, primary_key=True)
    config: Mapped[dict[str, Any]] = mapped_column(json_type, default=dict)
