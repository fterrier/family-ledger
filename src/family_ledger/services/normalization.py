from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from family_ledger.api.schemas import (
    MoneyValue,
    PostingPayload,
    TransactionCreate,
    TransactionNormalizeData,
)
from family_ledger.services.balancing import transaction_balance_totals_by_symbol
from family_ledger.services.errors import ValidationError
from family_ledger.services.validation import validate_transaction_payload


def normalize_transaction_payload(
    payload: TransactionCreate | TransactionNormalizeData,
) -> TransactionCreate:
    missing_units = [posting for posting in payload.postings if posting.units is None]
    missing_symbols = [
        posting
        for posting in payload.postings
        if posting.units is not None and posting.units.symbol is None
    ]
    missing_price_amounts = [
        posting
        for posting in payload.postings
        if posting.price is not None and posting.price.amount is None
    ]
    if len(missing_units) > 1:
        raise ValidationError(
            code="multiple_missing_postings",
            message="At most one posting may omit units when normalizing a transaction.",
        )
    if len(missing_symbols) > 1:
        raise ValidationError(
            code="multiple_missing_symbols",
            message="At most one posting may omit the units symbol when normalizing a transaction.",
        )

    for posting in payload.postings:
        if posting.units is None and (posting.cost is not None or posting.price is not None):
            raise ValidationError(
                code="missing_units_with_cost_or_price",
                message="A posting with missing units cannot also specify cost or price.",
            )
        if posting.units is not None and posting.units.symbol is None:
            if posting.cost is not None or posting.price is not None:
                raise ValidationError(
                    code="missing_symbol_with_cost_or_price",
                    message=(
                        "A posting with a missing units symbol cannot also specify cost or price."
                    ),
                )
        if posting.price is not None and posting.price.amount is None:
            if posting.cost is not None:
                raise ValidationError(
                    code="missing_price_with_cost",
                    message="A posting with a missing price amount cannot also specify cost.",
                )
            if posting.units is None or posting.units.symbol is None:
                raise ValidationError(
                    code="missing_price_without_explicit_units",
                    message="A posting with a missing price amount requires explicit units.",
                )

    if not missing_units and not missing_symbols and not missing_price_amounts:
        return TransactionCreate.model_validate(payload.model_dump())

    weights_by_symbol = transaction_balance_totals_by_symbol(payload.postings)

    missing_price_counts: dict[str, int] = {}
    for posting in missing_price_amounts:
        assert posting.price is not None
        missing_price_counts[posting.price.symbol] = (
            missing_price_counts.get(posting.price.symbol, 0) + 1
        )
    for symbol, count in missing_price_counts.items():
        if count > 1:
            raise ValidationError(
                code="multiple_missing_price_amounts_in_group",
                message=(
                    "At most one posting per balancing symbol group may omit a price amount. "
                    f"Found multiple missing price amounts for {symbol}."
                ),
            )

    if not weights_by_symbol:
        raise ValidationError(
            code="ambiguous_interpolation_symbol",
            message="Transaction interpolation requires at least one non-zero balancing weight.",
        )

    inferred_symbols = sorted(weights_by_symbol)
    if missing_symbols and len(inferred_symbols) != 1:
        raise ValidationError(
            code="ambiguous_missing_symbol",
            message=(
                "A posting with a missing units symbol requires one unambiguous balancing symbol."
            ),
        )

    normalized_postings = []
    for posting in payload.postings:
        if posting.units is None:
            for symbol, amount in weights_by_symbol.items():
                normalized_postings.append(
                    PostingPayload(
                        account=posting.account,
                        units=MoneyValue(amount=-amount, symbol=symbol),
                        cost=None,
                        price=None,
                        entity_metadata=posting.entity_metadata,
                    )
                )
        elif posting.units.symbol is None:
            normalized_postings.append(
                PostingPayload(
                    account=posting.account,
                    units=MoneyValue(amount=posting.units.amount, symbol=inferred_symbols[0]),
                    cost=None,
                    price=None,
                    entity_metadata=posting.entity_metadata,
                )
            )
        elif posting.price is not None and posting.price.amount is None:
            symbol = posting.price.symbol
            if posting.units.amount == 0:
                raise ValidationError(
                    code="missing_price_with_zero_units",
                    message="A posting with zero units cannot infer a missing price amount.",
                )
            implied_weight = weights_by_symbol.get(symbol, Decimal("0"))
            normalized_postings.append(
                PostingPayload(
                    account=posting.account,
                    units=MoneyValue(amount=posting.units.amount, symbol=posting.units.symbol),
                    cost=None,
                    price=MoneyValue(
                        amount=(-implied_weight / posting.units.amount),
                        symbol=symbol,
                    ),
                    entity_metadata=posting.entity_metadata,
                )
            )
        else:
            explicit_price = None
            if posting.price is not None:
                assert posting.price.amount is not None
                explicit_price = MoneyValue(
                    amount=posting.price.amount,
                    symbol=posting.price.symbol,
                )
            normalized_postings.append(
                PostingPayload(
                    account=posting.account,
                    units=MoneyValue(amount=posting.units.amount, symbol=posting.units.symbol),
                    cost=posting.cost,
                    price=explicit_price,
                    entity_metadata=posting.entity_metadata,
                )
            )

    return TransactionCreate(
        transaction_date=payload.transaction_date,
        payee=payload.payee,
        narration=payload.narration,
        entity_metadata=payload.entity_metadata,
        import_metadata=payload.import_metadata,
        postings=normalized_postings,
    )


def normalize_and_validate_transaction_payload(
    session: Session,
    payload: TransactionCreate | TransactionNormalizeData,
) -> TransactionCreate:
    normalized = normalize_transaction_payload(payload)
    validate_transaction_payload(session, normalized)
    return normalized
