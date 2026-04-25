from __future__ import annotations

from collections import deque
from decimal import Decimal
from enum import Enum
from typing import NamedTuple


class LotKey(NamedTuple):
    account: str
    units_symbol: str
    cost_symbol: str
    cost_per_unit: Decimal


class BookingMethod(str, Enum):
    FIFO = "FIFO"
    STRICT = "STRICT"
    STRICT_WITH_SIZE = "STRICT_WITH_SIZE"
    LIFO = "LIFO"
    HIFO = "HIFO"
    NONE = "NONE"


class TransactionLotDelta(NamedTuple):
    transaction_name: str
    amount: Decimal


class BookingFailure(NamedTuple):
    target: str
    lot_key: LotKey
    requested_amount: Decimal
    available_amount: Decimal


class BookingReplayResult(NamedTuple):
    failures: list[BookingFailure]
    open_lots_by_key: dict[LotKey, list[Decimal]]


def sign_of(value: Decimal) -> int:
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


class BookingReplay:
    def __init__(self, booking_method: BookingMethod = BookingMethod.FIFO) -> None:
        self.booking_method = booking_method

    def replay(self, deltas_by_lot: dict[LotKey, list[TransactionLotDelta]]) -> BookingReplayResult:
        if self.booking_method is not BookingMethod.FIFO:
            raise NotImplementedError(f"Unsupported booking method: {self.booking_method}")
        return self._replay_fifo(deltas_by_lot)

    def _replay_fifo(
        self, deltas_by_lot: dict[LotKey, list[TransactionLotDelta]]
    ) -> BookingReplayResult:
        failures: list[BookingFailure] = []
        open_lots_by_key: dict[LotKey, list[Decimal]] = {}
        for lot_key in sorted(deltas_by_lot):
            open_lots: deque[Decimal] = deque()
            for delta in deltas_by_lot[lot_key]:
                self._apply_fifo_transaction_delta(lot_key, delta, open_lots, failures)
            open_lots_by_key[lot_key] = list(open_lots)
        return BookingReplayResult(
            failures=failures,
            open_lots_by_key=open_lots_by_key,
        )

    def _apply_fifo_transaction_delta(
        self,
        lot_key: LotKey,
        delta: TransactionLotDelta,
        open_lots: deque[Decimal],
        failures: list[BookingFailure],
    ) -> None:
        delta_sign = sign_of(delta.amount)
        if delta_sign == 0:
            return

        if not open_lots or sign_of(open_lots[0]) == delta_sign:
            open_lots.append(delta.amount)
            return

        remaining = abs(delta.amount)
        available = sum((abs(amount) for amount in open_lots), start=Decimal("0"))
        while open_lots and remaining > 0:
            head = open_lots[0]
            head_amount = abs(head)
            consumed = min(head_amount, remaining)
            remaining -= consumed
            leftover = head_amount - consumed
            if leftover == 0:
                open_lots.popleft()
            else:
                open_lots[0] = Decimal(leftover).copy_sign(head)

        if remaining > 0:
            failures.append(
                BookingFailure(
                    target=delta.transaction_name,
                    lot_key=lot_key,
                    requested_amount=abs(delta.amount),
                    available_amount=available,
                )
            )
            open_lots.append(Decimal(remaining).copy_sign(delta.amount))
