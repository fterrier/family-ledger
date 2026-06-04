from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from family_ledger.models import Account


def load_account_name_set(session: Session) -> set[str]:
    return set(session.scalars(select(Account.name)).all())
