# Account Balance: Pad Computation & Balance Assertion Validation — Design v0.2

> Supersedes `pad-v0.1.md` and `balance-assertions-validation-v0.1.md`.

---

## Overview

Both pad computation (`GET /accounts/{account}:pad`) and balance assertion validation (`POST /ledger:doctor`) are built on a single shared function, `compute_balance_assertion_diffs`, that walks transactions and balance assertions in chronological order, maintaining a running balance per account.

- **Pad**: given an account and a pad date, returns the posting amounts a padding transaction would need to satisfy the first upcoming balance assertion per currency.
- **Balance assertion validation**: checks every stored balance assertion against the actual posting history; surfaces failures as `DoctorIssue(code=balance_assertion_failed)`.

Neither feature creates new DB models or migrations. Both are read-only computations.

---

## Beancount Semantics (verified against Beancount 3.2.0)

### Balance assertions

- Check **units only** — Beancount does not support cost-annotated balance directives; cost and price annotations on postings are ignored.
- Balance = sum of `units_amount` for the **account and all descendants** (`account_name LIKE 'A:B:%'`).
- An assertion on date D checks transactions with `transaction_date < D` (start-of-day: same-day transactions are not yet "in").
- Tolerance rules from project config apply (per-symbol or default).

### Pad

- A `pad` directive covers the **first balance assertion per currency** that occurs strictly after the pad date. Assertions for the same currency on later dates are not affected by this pad.
- With multiple currencies: one synthetic transaction per currency, all dated at the pad date.
- Pad on a **non-leaf account** is supported: the pad amount accounts for all descendants (same subtree sum as balance assertions).
- Pad on a **cost-tracked account** is an error in Beancount ("Attempt to pad an entry with cost for balance") — our API returns `ValidationError(code=pad_cost_tracked_account)`.
- Synthetic pad transactions have `cost=None` — no cost annotation on `PadEntry`.
- A pad only looks forward from its date; balance assertions before the pad date are irrelevant.

---

## Shared Algorithm: `compute_balance_assertion_diffs`

### Data returned

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

### Signature

```python
def compute_balance_assertion_diffs(
    session: Session,
    account_name_filter: str | None = None,
) -> list[BalanceAssertionDiff]:
```

### Algorithm

1. **Load balance assertions** ordered by `(assertion_date, name)`.
   If `account_name_filter`: `WHERE account_name = filter` (exact match; assertions are always on a specific account, not descendants).

2. **Load transactions with postings** ordered by `(transaction_date, name)`.
   If `account_name_filter`: only transactions with at least one posting on the account or a descendant (`account_name = filter OR account_name LIKE filter + ":%"`), using `.distinct()`.

3. **Merge-sort single pass** — maintains `running_balance: dict[str, dict[str, Decimal]]` (account_name → symbol → cumulative units):
   - Lazy-advance a transaction iterator: before evaluating an assertion dated D, consume all transactions with `transaction_date < D` and update `running_balance[account_name][symbol] += units_amount` per posting.
   - Compute `actual = sum(balances.get(symbol, 0) for acc, balances in running_balance.items() if acc == account_name or acc.startswith(account_name + ":"))`.
   - Append `BalanceAssertionDiff(diff = expected − actual, ...)`.

Non-leaf accounts work naturally: the descendant summation is identical whether the account is a leaf or a parent with children.

---

## `compute_pad`

**File:** `src/family_ledger/services/account_balance.py`

```
compute_pad(session, account_name, pad_date) -> PadResponse
```

1. `resolve_account(session, account_name)` — raises `NotFoundError` if missing.
2. Call `compute_balance_assertion_diffs(session, account_name_filter=account.account_name)`.
3. Keep only diffs with `assertion_date > pad_date`.
4. **Validate no cost-tracked positions**: for each remaining diff, check whether any posting on the account subtree with `units_symbol == diff.symbol` has `cost_symbol IS NOT NULL` and `transaction_date < diff.assertion_date`. If yes: `raise ValidationError(code="pad_cost_tracked_account")`.
5. **First per currency**: take only the first diff per symbol (results already ordered by date).
6. Drop entries where `abs(diff.diff) <= resolve_tolerance(diff.symbol)`.
7. Return `PadResponse(account=account.name, pad_date=pad_date, entries=[PadEntry(balance_assertion, assertion_date, units)])`.

### API

```
GET /accounts/{account:path}:pad?date=YYYY-MM-DD
```

Returns the amounts a padding transaction posted on `date` would need to satisfy the first upcoming balance assertion per currency. Empty `entries` means no padding is needed.

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

`doctor_ledger` calls `compute_balance_assertion_diffs(session)` (no filter) and surfaces non-zero diffs (outside tolerance) as `DoctorIssue`:

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

Balance assertion issues sort after transaction issues in the doctor response (their `target` is a `balanceAssertions/…` name, not in `transaction_order`).

---

## Beancount Importer

The importer uses a two-phase approach:

**Phase 1**: import accounts, commodities, transactions, and balance assertions in the standard flow.

**Phase 2** (after phase 1): for each `Pad` directive, call `compute_pad`. Per currency entry returned:
- `transaction_date`: pad directive date
- `narration`: `"Padding entry"`
- `entity_metadata`: `{"generated_by": "pad", "source_account": pad.source_account}`
- Postings: debit `pad.account`, credit `pad.source_account`, both in `entry.units`
- `source_native_id`: `f"beancount:pad:{entry.account}:{entry.date.isoformat()}:{entry.units.symbol}"`
- Duplicate detection: check `source_native_id` before calling `compute_pad` (avoids inflating the balance on re-import)

---

## Implementation Files

| File | Contents |
|------|----------|
| `src/family_ledger/services/transaction_balancing.py` | Single-transaction balancing helpers: `posting_weight`, `resolve_tolerance`, `build_transaction_unbalanced_issues`, `derive_normalize_issues` |
| `src/family_ledger/services/account_balance.py` | `BalanceAssertionDiff`, `compute_balance_assertion_diffs`, `compute_pad` |
| `src/family_ledger/services/doctor.py` | `doctor_ledger` — calls `compute_balance_assertion_diffs` to surface `balance_assertion_failed` issues |
| `src/family_ledger/api/ledger.py` | `GET /accounts/{account:path}:pad` route, delegates to `account_balance.compute_pad` |
| `src/family_ledger/api/schemas.py` | `PadEntry` (no `cost` field), `PadResponse` |
| `importers/src/family_ledger_importers/beancount.py` | Phase 2 pad handling: per-currency `source_native_id`, iterates all entries returned by `compute_pad` |

---

## Test Cases

### `tests/test_services_account_balance.py`

**`compute_balance_assertion_diffs`:**

| Case | Expected |
|------|----------|
| No assertions | `[]` |
| Exact match | diff=0 |
| Account short | diff=positive |
| Tx before assertion counted | counted |
| Tx on assertion date excluded | not counted |
| Descendant balances summed | parent actual = sum(parent + children) |
| Non-leaf account pad + balance | correct delta including descendants |
| Multiple currencies | separate diffs per currency |
| Account filter | returns only the filtered account's diffs |

**`compute_pad`:**

| Case | Expected |
|------|----------|
| No transactions, assertion 1000 USD | `[{1000 USD}]` |
| Same-date tx +500, assertion 1000 | `[{500}]` |
| Next-day tx +500, assertion 1000 | `[{500}]` |
| Descendant balance 200, parent assertion 1000 | `[{800}]` |
| Non-leaf: tx in child, pad + balance on parent | correct delta |
| No assertion after pad date | `[]` |
| Delta within CHF tolerance | `[]` |
| Two assertions (same currency): only first returned | one entry for the earlier assertion |
| Two currencies in balance assertions | two entries |
| Cost-tracked posting for asserted currency | `ValidationError(code=pad_cost_tracked_account)` |
| Unknown account | `NotFoundError` |

### `tests/test_api_ledger.py` — pad section

| Case | Expected |
|------|----------|
| Happy path | 200, correct JSON shape (fields, date format, decimal as string) |
| Unknown account | 404 + error code |
| Cost-tracked account | 400 + `code=pad_cost_tracked_account` |

### `tests/test_services_doctor.py` — balance assertion extension

| Case | Expected |
|------|----------|
| Failing assertion | `DoctorIssue(code=balance_assertion_failed)` |
| Passing assertion | no such issue |

### `tests/test_api_ledger.py` — doctor extension

| Case | Expected |
|------|----------|
| `POST /ledger:doctor` with failing assertion | `balance_assertion_failed` in issues |
| `POST /ledger:doctor` with passing assertion | no `balance_assertion_failed` |

### `importers/tests/test_beancount.py` — pad extension

| Case | Expected |
|------|----------|
| Basic pad | synthetic transaction created; balance assertion created |
| Pad + same-date tx | reduced pad amount |
| Pad + next-day tx | reduced pad amount |
| Idempotent re-import | no duplicates |
| Multi-currency pad | two transactions created (one per currency), idempotent |

---

## Future: Transaction Cache for Doctor

Every `POST /ledger:doctor` call fetches all transactions from disk. For large ledgers, a process-level or request-scoped cache keyed on a ledger-level sequence number would avoid redundant DB round-trips. Defer until profiling shows it is needed.
