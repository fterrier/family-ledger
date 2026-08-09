from __future__ import annotations

import logging
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from family_ledger.models import Posting, Transaction, current_update_time
from family_ledger.services.transaction_balancing import (
    persisted_posting_weight,
    resolve_tolerance,
)

_log = logging.getLogger(__name__)


def backfill_unbalanced_transaction_fillers(session: Session) -> int:
    """One-time catch-up for rows persisted before persist_transaction started
    appending a balancing accountless posting on every write (see ADR 0012).
    Every write from that point on is already self-balancing, so this never
    needs to run again on the same data — sums every posting including any
    already-present accountless one (same "is anything structurally
    missing" semantics as compute_full_balance_residuals_for_payload), so a
    transaction that's already balanced overall is left untouched. Returns
    the number of transactions a filler posting was added to.
    """
    transactions = (
        session.execute(select(Transaction).options(selectinload(Transaction.postings)))
        .scalars()
        .all()
    )

    backfilled = 0
    for transaction in transactions:
        totals: dict[str, Decimal] = {}
        for posting in transaction.postings:
            weight = persisted_posting_weight(posting)
            totals[weight.symbol] = totals.get(weight.symbol, Decimal(0)) + weight.amount

        residuals = {
            symbol: amount
            for symbol, amount in totals.items()
            if abs(amount) > resolve_tolerance(symbol)
        }
        if not residuals:
            continue

        next_order = max((p.posting_order for p in transaction.postings), default=0) + 1
        for symbol in sorted(residuals):
            transaction.postings.append(
                Posting(
                    account=None,
                    posting_order=next_order,
                    units_amount=-residuals[symbol],
                    units_symbol=symbol,
                    entity_metadata={},
                )
            )
            next_order += 1

        transaction.updated_at = current_update_time()
        backfilled += 1

    if backfilled:
        session.flush()
        _log.info("Backfilled balancing postings for %d transaction(s).", backfilled)
    return backfilled
