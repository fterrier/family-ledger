# Account Balance: Pad Computation & Balance Assertion Validation — Design v0.2

> Supersedes `pad-v0.1.md` and `balance-assertions-validation-v0.1.md`.

---

## Overview

Both pad computation (`GET /accounts/{account}:pad`) and balance assertion validation (`POST /ledger:doctor`) are built on a single shared pure function, `compute_balance_assertion_diffs`, that walks pre-loaded transactions and balance assertions in chronological order, maintaining a running balance per account.

- **Pad**: given an account and a pad date, returns the posting amounts a padding transaction would need to satisfy the first upcoming balance assertion per currency.
- **Balance assertion validation**: checks every stored balance assertion against the actual posting history; surfaces failures as `DoctorIssue(code=balance_assertion_failed)`.

Neither feature creates new DB models or migrations. Both are read-only computations.

---

## Beancount Semantics (verified against Beancount 3.2.0)

### Balance assertions

- Check **units only** — cost and price annotations on postings are ignored.
- Balance = sum of `units_amount` for the **account and all descendants** (`account_name LIKE 'A:B:%'`).
- An assertion on date D checks transactions with `transaction_date < D` (start-of-day; same-day transactions are not yet "in").
- Tolerance rules from project config apply (per-symbol or default).

### Pad

- A `pad` directive covers the **first balance assertion per currency** that occurs strictly after the pad date. Later assertions for the same currency are unaffected.
- With multiple currencies: one synthetic transaction per currency, all dated at the pad date.
- Pad on a **non-leaf account** is supported: the pad amount accounts for all descendants.
- Pad on a **cost-tracked account** is rejected — our API returns `ValidationError(code=pad_cost_tracked_account)`.
- Synthetic pad transactions have `cost=None`.

---

## Shared Algorithm: `compute_balance_assertion_diffs`

### Signature

```python
def compute_balance_assertion_diffs(
    transactions: Sequence[Transaction],          # sorted by (transaction_date, name)
    balance_assertions: Sequence[BalanceAssertion],  # sorted by (assertion_date, name)
) -> list[BalanceAssertionDiff]:
```

The function is **pure** — it takes pre-loaded ORM objects and performs no DB queries. Query logic lives at each call site.

### Return type

```python
@dataclass
class BalanceAssertionDiff:
    balance_assertion: str   # resource name
    assertion_date: date
    account_name: str
    symbol: str
    expected: Decimal
    actual: Decimal
    diff: Decimal            # expected − actual; positive = account is short
```

### Algorithm

Single in-memory merge-sort pass over both sorted sequences:

1. Maintain `running_balance: dict[account_name, dict[symbol, Decimal]]`.
2. For each balance assertion (in order), lazily advance a shared transaction iterator: consume all transactions with `transaction_date < assertion_date`, updating `running_balance[account_name][symbol] += units_amount` per posting.
3. Compute `actual = sum(balances.get(symbol, 0) for acc, balances in running_balance.items() if acc == account_name or acc.startswith(account_name + ":"))`.
4. Append `BalanceAssertionDiff(diff = expected − actual, ...)`.

Non-leaf accounts work naturally: descendant summation is identical whether the account is a leaf or a parent.

### Call sites

**`compute_pad`** — loads only the relevant account subtree before calling:
```python
balance_assertions = session.scalars(
    select(BalanceAssertion)
    .where(Account.account_name == account.account_name)
    .order_by(BalanceAssertion.assertion_date, BalanceAssertion.name)
).all()
transactions = session.scalars(
    select(Transaction)
    .where(Account.account_name == account.account_name OR LIKE account + ":%")
    .order_by(Transaction.transaction_date, Transaction.name)
    .distinct()
).all()
diffs = compute_balance_assertion_diffs(transactions, balance_assertions)
```

**`doctor_ledger`** — loads all transactions (already loaded for other checks) and all balance assertions:
```python
transactions = _load_transactions_for_doctor(session)   # shared with unbalanced/lot checks
balance_assertions = _load_balance_assertions_for_doctor(session)
diffs = compute_balance_assertion_diffs(transactions, balance_assertions)
```

This design eliminates the duplicate transaction load that would occur if the function fetched its own data.

---

## `compute_pad`

**File:** `src/family_ledger/services/account_balance.py`

```
compute_pad(session, account_name, pad_date) -> PadResponse
```

1. Resolve account — raises `NotFoundError` if missing.
2. Load balance assertions filtered to the account; load transactions filtered to account subtree.
3. Call `compute_balance_assertion_diffs(transactions, balance_assertions)`.
4. Keep only diffs with `assertion_date > pad_date`.
5. **Validate no cost-tracked positions**: for each remaining diff, check whether any posting on the account subtree with `units_symbol == diff.symbol` has `cost_symbol IS NOT NULL` and `transaction_date < diff.assertion_date`. If yes: raise `ValidationError(code="pad_cost_tracked_account")`.
6. **First per currency**: take only the first diff per symbol (results are ordered by date).
7. Drop entries where `abs(diff.diff) <= resolve_tolerance(diff.symbol)`.
8. Return `PadResponse`.

### Response schema

```python
class PadEntry(BaseModel):
    balance_assertion: str    # resource name of the target assertion
    assertion_date: date
    units: MoneyValue         # amount needed (positive = deposit, negative = withdrawal)

class PadResponse(BaseModel):
    account: str              # resource name
    pad_date: date
    entries: list[PadEntry]
```

---

## Balance Assertion Validation in Doctor

**File:** `src/family_ledger/services/doctor.py`

`doctor_ledger` surfaces non-zero diffs (outside tolerance) as `DoctorIssue`:

```python
DoctorIssue(
    target=diff.balance_assertion,
    code="balance_assertion_failed",
    severity="error",
    message="Balance assertion not satisfied.",
    details={
        "symbol": diff.symbol,
        "asserted_amount": ...,
        "actual_amount": ...,
        "diff": ...,
        "tolerance": ...,
    },
)
```

Balance assertion issues sort after transaction issues (their `target` is a `balanceAssertions/…` name, absent from `transaction_order`).

---

## Beancount Importer

The importer uses a two-phase approach:

**Phase 1**: import accounts, commodities, transactions, and balance assertions.

**Phase 2** (after phase 1): for each `Pad` directive, call `compute_pad`. Per currency entry returned:
- `transaction_date`: pad directive date
- `narration`: `"Padding entry"`
- `entity_metadata`: `{"generated_by": "pad", "source_account": pad.source_account}`
- Postings: debit `pad.account`, credit `pad.source_account`
- `source_native_id`: `f"beancount:pad:{entry.account}:{entry.date.isoformat()}:{entry.units.symbol}"`
- Duplicate detection: check `source_native_id LIKE prefix + "%"` before calling `compute_pad` (prevents balance inflation on re-import)

---

## Implementation Files

| File | Contents |
|------|----------|
| `src/family_ledger/services/transaction_balancing.py` | Single-transaction balancing helpers: `posting_weight`, `resolve_tolerance`, `build_transaction_unbalanced_issues` |
| `src/family_ledger/services/account_balance.py` | `BalanceAssertionDiff`, `compute_balance_assertion_diffs` (pure), `compute_pad` |
| `src/family_ledger/services/doctor.py` | `doctor_ledger` — loads data inline, calls pure function, surfaces `balance_assertion_failed` |
| `src/family_ledger/api/ledger.py` | `GET /accounts/{account:path}:pad` route |
| `src/family_ledger/api/schemas.py` | `PadEntry`, `PadResponse` |
| `importers/src/family_ledger_importers/beancount.py` | Phase 2 pad handling |

---

## Future: Transaction Cache for Doctor

Every `POST /ledger:doctor` call fetches all transactions. For large ledgers, a process-level cache keyed on a ledger-level sequence number would reduce repeated DB round-trips. Defer until profiling shows it is needed.
