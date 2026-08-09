"""backfill balancing accountless postings for pre-existing unbalanced transactions

Revision ID: 0015_backfill_balance_fillers
Revises: 0014_nullable_posting_account
Create Date: 2026-08-09 00:00:00
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from alembic import op
from family_ledger.scripts.backfill_unbalanced_postings import (
    backfill_unbalanced_transaction_fillers,
)

revision = "0015_backfill_balance_fillers"
down_revision = "0014_nullable_posting_account"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Every transaction written from now on is self-balancing at persist
    # time (persist_transaction, see ADR 0012) — this is a one-time
    # catch-up for rows that were already stored before that behavior
    # existed. Idempotent: safe to run again against already-backfilled or
    # already-balanced data (see backfill_unbalanced_transaction_fillers).
    session = Session(bind=op.get_bind())
    backfill_unbalanced_transaction_fillers(session)
    session.commit()


def downgrade() -> None:
    # Not reversible: nothing on a filler posting distinguishes "added by
    # this backfill" from "added by ordinary app writes since" — deleting
    # every account-is-null posting would also destroy legitimate ones
    # created after this migration ran.
    pass
