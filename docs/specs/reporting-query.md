# Reporting Query And Account Detail

> Status: **implemented** — backend `POST /ledger:query` (2026-07-06, with
> beanquery parity tests in `tests/integration/test_query_parity.py`) and
> the mobile account view (2026-07-08: chart card on the home screen driven
> by the global filter, doctor overlay, picker polish). Decision record:
> ADR 0011.

## Use Case

From the mobile app, pick an account and open a dedicated **account detail
screen** showing:

- **P0 — balance over time**: a chart of the account's evolution, so trends
  (savings growing, checking draining) and data problems (import gaps,
  missing opening balances) are visible at a glance.
- **P1 — transactions**: the transactions touching that account, to drill
  from "the balance dipped in March" into *why*.

Two audiences for the chart:

1. *Financial insight* — trend of stock-type accounts (Assets/Liabilities).
2. *Data verification* — after importer runs, a balance curve makes
   duplicates and gaps visually obvious in a way a transaction list never
   will.

Chart shape adapts per account category:

- **Assets / Liabilities / Equity**: line chart of the running balance.
- **Expenses / Income**: bar chart of per-month totals (a running total is a
  monotonically growing line with little information).

## Architectural Decision: a Reporting Query Endpoint

Rather than a bespoke `balanceSeries` endpoint, the backend gains one
flexible read-only reporting endpoint that accepts a **subset of the
Beancount Query Language (BQL)**, parsed and validated server-side and
compiled to SQL. This serves the balance chart, the expense bars, and future
reports (net worth, category breakdowns, Sheets reporting) from one surface.

- v1 implements only the **minimal BQL subset the charts need**; the grammar
  and AST are designed to grow toward fuller BQL (payee/tags filters,
  ORDER BY, LIMIT, more functions later).
- Aligning with BQL keeps semantics documented elsewhere (bean-query docs),
  makes queries portable against the Beancount export, and avoids inventing
  a dialect.
- The language is an **internal client–server contract** for now, not
  user-facing. Clients build queries programmatically; humans see charts.
- Security: the client never sends SQL. The server lexes/parses into an AST,
  validates every identifier and function against a whitelist, and builds a
  SQLAlchemy Core select with bound parameters. Read-only session.

When implemented, record the decision as ADR 0011.

## `POST /ledger:query`

Follows the `POST /ledger:doctor` custom-verb style. Auth required.

Request:

```json
{ "query": "SELECT year(date) AS y, month(date) AS m, last(balance) AS bal FROM OPEN ON 2025-07-01 WHERE account ~ '^Assets:Checking:ZKB(:|$)' GROUP BY y, m" }
```

Response (`200`): a positional table.

```json
{
  "columns": [
    {"name": "y", "type": "int"},
    {"name": "m", "type": "int"},
    {"name": "bal", "type": "inventory"}
  ],
  "rows": [
    [2025, 7, [{"number": "5800", "currency": "CHF"}]],
    [2025, 8, [{"number": "4000", "currency": "CHF"},
               {"number": "50", "currency": "USD"}]]
  ],
  "warnings": []
}
```

### Cell encoding

Each cell in a row is encoded according to its column's `type`:

| `type` | JSON encoding | Example |
|---|---|---|
| `int` | number | `2025` |
| `str` | string, or `null` (e.g. missing payee) | `"Expenses:Groceries"` |
| `date` | `YYYY-MM-DD` string | `"2025-07-20"` |
| `decimal` | normalized string (per API rules; trailing zeros dropped) | `"200"` |
| `amount` | `{"number": <decimal string>, "currency": <str>}`, or `null` when a conversion had no usable price | `{"number": "4040", "currency": "CHF"}` |
| `inventory` | array of amounts, sorted by currency; zero amounts omitted (may be empty) | `[{"number": "50", "currency": "USD"}]` |

### How the executor assembles a response

1. **Guardrails**: query text over 10 000 characters → `400 query_parse_error`.
2. **Parse + compile** (`400` on `query_parse_error` / `query_validation_error`).
3. **Seed** (running-balance queries with `OPEN ON` only): run `seed_select`
   for per-currency opening balances.
4. **Main select**: SQL rows are per *(group keys…, currency)*. More than
   10 000 result rows → `400 query_result_too_large`.
5. **Fold currencies**: the API response has **one row per group-key
   combination** — the internal currency dimension is folded into
   `inventory` cells. Ungrouped aggregates return exactly one row. Journal
   queries return one row per posting, ordered by date.
6. **Running balance** (`last(balance)`): per currency, cumulatively sum the
   bucket deltas on top of the seed. Every returned bucket carries the *full*
   inventory — all currencies seen so far, not just the ones that moved in
   that bucket. Buckets with no postings at all produce no row (clients
   carry the last value forward when drawing).
7. **Conversion** (`convert()`): conversion date = the explicit date argument
   if given; else the bucket's end date (`y` → Dec 31, `y, m` → last day of
   month, `y, m, d` → that day); else today for ungrouped queries. Prices
   are loaded in one bulk query; per bucket the latest price on or before
   the conversion date wins, with the inverse pair (1/rate) and then a
   single intermediate hop (`base → X → target`) as fallbacks. Amounts
   already in the target currency pass through at rate 1. A currency with
   no usable path makes the cell `null` and appends a `missing_price`
   warning.
8. **Serialize** per the cell-encoding table.

### Worked examples

All examples use this ledger: `Assets:Checking:ZKB` opens with 1000 CHF in
May 2025; July: salary +5000, groceries −200; August: groceries −300,
rent −1500, and +50 USD arrives on the `:Sub` sub-account. One stored price:
`USD→CHF 0.80` dated 2025-08-10.

**1. Balance line (per-currency running balance)** — see the request/response
at the top of this section: July balance is `1000 + 4800 = 5800 CHF`; the
August row carries both the updated CHF balance and the new USD position.

**2. Market value line (converted)**:

```json
{ "query": "SELECT year(date) AS y, month(date) AS m, convert(last(balance), 'CHF') AS bal FROM OPEN ON 2025-07-01 WHERE account ~ '^Assets:Checking:ZKB(:|$)' GROUP BY y, m" }
```

```json
{
  "columns": [
    {"name": "y", "type": "int"},
    {"name": "m", "type": "int"},
    {"name": "bal", "type": "amount"}
  ],
  "rows": [
    [2025, 7, {"number": "5800", "currency": "CHF"}],
    [2025, 8, {"number": "4040", "currency": "CHF"}]
  ],
  "warnings": []
}
```

August is `4000 + 50 × 0.80 = 4040` (price of 2025-08-10 is the latest on
or before the bucket end 2025-08-31). If the USD price were missing:

```json
{
  "rows": [
    [2025, 7, {"number": "5800", "currency": "CHF"}],
    [2025, 8, null]
  ],
  "warnings": [
    {
      "code": "missing_price",
      "message": "No CHF price for USD on or before 2025-08-31.",
      "details": {"base": "USD", "quote": "CHF", "date": "2025-08-31"}
    }
  ]
}
```

**3. Expense bars (per-month inventory)**:

```json
{ "query": "SELECT year(date) AS y, month(date) AS m, sum(position) AS total WHERE account ~ '^Expenses:Groceries(:|$)' AND date >= 2025-07-01 GROUP BY y, m" }
```

```json
{
  "columns": [
    {"name": "y", "type": "int"},
    {"name": "m", "type": "int"},
    {"name": "total", "type": "inventory"}
  ],
  "rows": [
    [2025, 7, [{"number": "200", "currency": "CHF"}]],
    [2025, 8, [{"number": "300", "currency": "CHF"}]]
  ],
  "warnings": []
}
```

**4. Journal (one row per posting)**:

```json
{ "query": "SELECT date, account, number, currency WHERE account ~ '^Expenses:Groceries(:|$)'" }
```

```json
{
  "columns": [
    {"name": "date", "type": "date"},
    {"name": "account", "type": "str"},
    {"name": "number", "type": "decimal"},
    {"name": "currency", "type": "str"}
  ],
  "rows": [
    ["2025-07-20", "Expenses:Groceries", "200", "CHF"],
    ["2025-08-03", "Expenses:Groceries", "300", "CHF"]
  ],
  "warnings": []
}
```

### Client contract

- `rows` are positional arrays aligned with `columns`; clients must dispatch
  on `columns[i].type`, not guess from values.
- One response row per group-key combination (currency lives inside
  `inventory`/`amount` cells); journal queries return one row per posting.
- Rows are ordered by group keys ascending (journal: by date ascending).
  `ORDER BY` is reserved for a later version.
- Absent buckets mean "no postings in that period", never "zero balance" —
  for running-balance charts, carry the previous value forward.
- `warnings` are non-fatal; a response with warnings is still `200` and
  usable. Clients should surface `missing_price` rather than hide gaps.
- Decimal strings preserve server-side precision; clients must not parse
  them as floats for arithmetic (display formatting is fine).
- New column types and warning codes may be added later; clients should
  ignore cells/warnings they do not understand rather than fail.

### Errors

All errors use the standard `{"detail": {"code": ..., "message": ...}}`
envelope:

| HTTP | `code` | When |
|---|---|---|
| 400 | `query_parse_error` | syntax error, or query text over 10 000 chars |
| 400 | `query_validation_error` | unknown column/function, bad grouping, duplicate output names, type-mismatched comparison, invalid regex, database-rejected predicate (backstop), … |
| 400 | `query_result_too_large` | more than 10 000 result rows |
| 401 | — | missing/invalid bearer token (standard auth behavior) |

## Query Language: BQL Subset (v1)

As in BQL, the logical table is **postings** (each row a posting joined to
its transaction and account). `WHERE` filters postings; `FROM` operates at
the transaction level.

### Grammar

```
query       := SELECT target ("," target)*
               (FROM from_opts)?
               (WHERE condition (AND condition)*)?
               (GROUP BY group_key ("," group_key)*)?
target      := expr (AS identifier)?
from_opts   := (OPEN ON date_literal)? (CLOSE ON date_literal)?
condition   := column op literal   -- v1: bare column left, literal right
op          := "=" | "!=" | "<" | "<=" | ">" | ">=" | "~"
group_key   := identifier | ordinal    -- alias, column, or 1-based position
expr        := column | function_call | literal
```

Date literals are unquoted `YYYY-MM-DD`; strings are single-quoted; number
literals may carry a leading minus. All BQL. Comparison literals must match
the column's type (`date` ↔ date literal, `number` ↔ number literal, string
columns ↔ string literal) — mismatches are `query_validation_error`.

### Columns (v1)

| Column | Type | Meaning |
|---|---|---|
| `date` | date | transaction date |
| `account` | str | full account name |
| `payee` | str | transaction payee |
| `narration` | str | transaction narration |
| `number` | decimal | posting units amount |
| `currency` | str | posting units currency |
| `position` | position | the posting's units as an amount |
| `balance` | inventory | running balance of matched postings, in date order |

### Functions (v1)

| Function | Kind | Meaning |
|---|---|---|
| `year(date)`, `month(date)`, `day(date)` | scalar | integer parts, as in BQL |
| `sum(position)` | aggregate | inventory sum (per-currency, like BQL) |
| `count(*)` | aggregate | row count |
| `last(expr)` | aggregate | last value in date order (used with `balance`) |
| `convert(expr, 'SYM' [, date])` | scalar | currency conversion via the prices table |

### Operators

- `~` is **regex match** (BQL semantics), not prefix match. Subtree matching
  is written `account ~ '^Assets:Checking(:|$)'` — the same effective
  semantics as `account_balance.py` and pad, expressed as a regex. Clients
  regex-escape account names when building queries.
- `=`, `!=`, `<`, `<=`, `>`, `>=` on comparable types.

### Multi-Currency: Inventories, Not Errors

As in BQL, `sum(position)` and `balance` yield **inventories** — one amount
per currency. Nothing is ever silently added across currencies; a
multi-currency account simply returns multi-amount cells, and clients decide
to render per-currency or to `convert()`.

### Opening Balances: `FROM OPEN ON`

`FROM OPEN ON 2025-07-01` summarizes all transactions before that date into
opening balances at that date (BQL semantics). This is how a windowed balance
chart starts at the *true* balance instead of zero. Implementation note: the
server realizes this as a seed aggregate query rather than materializing
synthetic summarization transactions — semantically equivalent for the
supported subset.

`CLOSE ON` is parsed and applied as an exclusive upper date bound (v1 does
not implement income summarization since income/expense clearing is not
needed for these charts).

### `convert()` Dates

BQL signature: `convert(amount_or_inventory, currency [, date])`.

- explicit `date` argument → use latest price on or before that date
- omitted, in a query grouped by date buckets → **the bucket's end date**
  (documented deviation from bean-query, which uses the latest price date;
  bucket-end is what a value-over-time series needs)
- omitted, ungrouped → today

Price lookup: latest `price_date <= target date` for the pair; inverse pair
(1/rate) as first fallback; then a **single intermediate hop**
(`base → X → target`, e.g. `ESGV → USD → CHF` for stock commodities priced
only in USD) — when several intermediates qualify, the one with the freshest
base-leg price wins. No usable path → `null` cell + `missing_price` warning.
(bean-query only hops via a position's cost currency; we hop via the price
graph, which covers that case and cost-less positions too.)

### Deviations From bean-query (v1)

| Area | bean-query | this subset |
|---|---|---|
| `balance` in aggregates | journal-only column | `last(balance)` allowed with GROUP BY — running balance at bucket end |
| `convert()` default date | latest price in DB | bucket end date in bucketed queries |
| `FROM` expressions | full boolean transaction filters, `CLEAR` | only `OPEN ON` / `CLOSE ON` |
| `ORDER BY`, `LIMIT`, `DISTINCT`, `HAVING`, `PIVOT` | supported (except HAVING) | not in v1; grammar reserved |
| Everything else implemented | — | matches BQL semantics |

### The Queries The Mobile App Sends

```sql
-- Assets/Liabilities: balance line, monthly, market value in CHF
SELECT year(date) AS y, month(date) AS m,
       convert(last(balance), 'CHF') AS bal
FROM OPEN ON 2025-07-01
WHERE account ~ '^Assets:Checking:ZKB(:|$)'
GROUP BY y, m

-- Single-currency variant (no conversion, always truthful)
SELECT year(date) AS y, month(date) AS m, last(balance) AS bal
FROM OPEN ON 2025-07-01
WHERE account ~ '^Assets:Checking:ZKB(:|$)' AND currency = 'CHF'
GROUP BY y, m

-- Expenses/Income: monthly bars (inventory per month, or convert(...))
SELECT year(date) AS y, month(date) AS m, sum(position) AS total
WHERE account ~ '^Expenses:Groceries(:|$)' AND date >= 2025-07-01
GROUP BY y, m
```

Months with no postings return no row; the client carries the last balance
forward when drawing the line (and zero-fills bars).

`convert(last(balance), 'CHF')` at bucket end dates is what makes investment
accounts (IBKR) chart as **market value over time**; for cash accounts the
same query is simply the balance.

### Backend Implementation

New package `src/family_ledger/services/query/`:

- `lexer.py` — tokenizer (keywords, identifiers, strings, dates, numbers)
- `ast.py` — frozen dataclasses for the query tree
- `parser.py` — recursive descent → AST
- `compiler.py` — AST → SQLAlchemy Core select + post-processing plan
  (OPEN ON seed query, running balance, bucket-end conversion). Date parts
  via `extract('year'/'month', ...)`, which SQLAlchemy compiles for both
  SQLite and Postgres. Anchored-prefix regexes (the common
  `^Account:Name(:|$)` shape) compile to `=`/`LIKE`; general regexes use
  Postgres `~` and a registered `REGEXP` function on SQLite.
- `executor.py` — runs select(s), applies post-processing (Decimal
  arithmetic, inventory assembly in Python), loads needed prices in one
  query, emits columns/rows/warnings

API: `api/query.py` router with `POST /ledger:query`.

## Mobile App (implemented 2026-07-08)

**The filter IS the account selection.** One app-global `TransactionFilter`
(already persisted via `FilterPersistence`) drives everything. When
`filter.account` is set, the home transaction list becomes the account view:
an `AccountChartCard` leads the list, sharing the filter's date range with
the transaction rows below it. There is no separate account-detail screen
and no second range vocabulary — "filtering to one account" and "selecting
an account" are the same operation by construction.

New dependency: `fl_chart` (contained in `widgets/account_chart_card.dart`).

### User Journeys (UX decisions 2026-07-07)

1. **Check on an account**: drawer → Accounts → pick (search-as-you-type,
   prefixes selectable) → home shows current balance + trend + scoped list.
2. **Why did it dip?** (also the import-anomaly journey): a doctor issue or
   an odd-looking curve → tap that point/bar → the shared filter narrows to
   that bucket, the list follows → tap a transaction → existing edit
   screen. Deliberate post-import chart checking matters mainly for
   sparse-assertion accounts (pensions/historical imports) where doctor is
   blind to gaps.
3. **Spending pulse**: expense subtree → monthly bars, compare months.
4. **Portfolio value**: invested accounts → converted market-value line.

Display conventions: **raw ledger signs everywhere** (liabilities plot
below zero; a rising line means shrinking debt) — no per-category sign
inversion, except expense/income *bars* which display magnitudes.

### Ranges and granularity

No relative presets (no 3M/1Y chips): the existing filter sheet (year pills
+ FROM/TO month-year picker) is the only range editor, and the card shows
the filter's `dateRangeLabel`. Default view = whatever the persisted filter
says; Reset = all history.

Bucket granularity defaults to a span-derived heuristic (`granularityForSpan`
in `core/bql.dart`): ≤ ~4 months daily, ≤ ~4 years monthly, longer (or
unbounded start) yearly. A `Day | Month | Year` chip row on the card lets
the user override this per view; the pick sticks until the account or date
range changes (including a bucket-tap narrowing), at which point it resets
back to the span-derived default for the new view.

### AccountChartCard (`widgets/account_chart_card.dart`)

- **Header**: category icon, account name, current balance (last point) or
  range total for expense/income, range-delta chip for balance accounts,
  and the range label
- Assets/Liabilities/Equity → running-balance line (`last(balance)`,
  `FROM OPEN ON` seeding, carry-forward across empty buckets); Expenses/
  Income → magnitude bars (`sum(position)`, zero-filled gaps)
- scrub tooltip (date + value); tapping a bucket narrows the shared filter
  to that bucket via the same persist/notify/refresh path as the sheet
- axis labels thin themselves to fit: the widest bucket label's measured
  width vs. the available plot width picks how many buckets to skip
  between labels, so dense ranges (e.g. daily buckets over months) don't
  overlap
- Expenses/Income bar width is likewise sized from the plot width and
  bucket count (fl_chart's `BarChartAlignment.spaceEvenly` default spaces
  groups evenly but never shrinks a fixed rod width to fit), so bars
  neither collide at high bucket counts (daily granularity) nor look like
  thin slivers against wide gaps at low bucket counts (yearly)
- currency: the commodity to chart is part of the shared, persisted
  `TransactionFilter` (same "Commodity" row in the filter sheet that scopes
  the transaction list) — not a per-card chip. A series with more than one
  currency (no filter applied, or the account naturally holds several) has
  no single "unit" to fall back to, so it always shows the combined
  converted view (default currency from app settings); a single-currency
  series (filtered to one commodity, or naturally single-currency) just
  shows that currency's raw values, no conversion. A raw/converted toggle
  for the single-currency case was prototyped and deliberately removed —
  see Risks/Notes
- **warnings are a display requirement**: `missing_price` warnings show an
  amber count badge (tap → list) and `null` cells render as line gaps that
  also poison carry-forward until the next known value
- the chart reflects account + dates only; a hint appears when the
  `last import` filter toggle is active
- **doctor overlay**: failed balance assertions for the account subtree
  render as translucent red bands over their buckets plus a red count badge
  (tap → sheet listing date, expected, actual, diff per failure)

### Account selection and picker

- Drawer entry **Accounts** opens the existing `AccountPickerScreen` with
  the prefix superset (`core/account_hierarchy.dart` `buildPickerAccounts`,
  shared with the filter sheet) and applies the result to the global filter
  (`TransactionListScreenState.selectAccount`)
- closed accounts (`effective_end_date` set) are hidden behind a
  "show closed" toggle (prefix rows always visible), dimmed when revealed —
  in every picker context
- picker rows show the home list's 4 px red issue bar when the account's
  subtree has failed balance assertions

### Client plumbing

- `repositories/query_repository.dart` — `run(query)` → `QueryResult`
  (typed int/str/date/decimal/amount/inventory cells; unknown column types
  pass through for forward compatibility)
- `core/bql.dart` — query-string builders incl. regex-escaping account
  names into the `^...(:|$)` subtree pattern and span→granularity; a
  `currency` filter and a `convertTo` target can be combined in the same
  query (a single commodity, shown converted)
- `core/chart_series.dart` — pure series assembly: bucket math, gap
  filling/carry-forward, magnitude bars, converted series
- `screens/transactions/transaction_filter.dart` +
  `core/filter_persistence.dart` — the commodity filter is a field on the
  same persisted `TransactionFilter` as account/dates/last-import, so it
  scopes the transaction list (`GET /transactions?currency=...`, backend
  filter on `Posting.units_symbol`) and the chart identically
- `models/doctor_issue.dart` + `TransactionRepository.runDoctorIssues()` —
  full doctor issues; the home list's transaction-issue set is derived from
  the same single doctor call

## Testing

Backend (pytest, run with `uv run`):

- lexer/parser golden tests (query string → expected AST, parse errors)
- validator tests (unknown column/function, `last(balance)` without a date
  bucket, malformed regex)
- executor tests against seeded SQLite: subtree regex matching, `OPEN ON`
  seeding with a windowed range, inventory sums across currencies,
  bucket-end vs explicit-date conversion, inverse price fallback,
  `missing_price` warning
- API route tests: auth, error envelope, response shape

Mobile (flutter test):

- BQL builder unit tests (exact query strings, regex escaping, granularity)
- `chart_series` unit tests (bucket ends incl. leap years, carry-forward,
  null poisoning, zero-fill, magnitudes)
- `QueryRepository` tests with mocked `ApiClient` (all cell types, unknown
  types, malformed responses)
- widget tests: line vs bars per category, raw liability signs, delta chip,
  the forced-converted view (multi-currency, no toggle) vs. the raw
  single-currency view (no toggle either), warning badge + sheet,
  assertion badge/bands/sheet, chart card presence driven by the filter,
  bucket tap narrowing + persistence, picker closed-toggle and red bars,
  granularity chip row (span-derived default, resets on account/date
  change but survives a refreshTick- or commodity-filter-only reload),
  axis-label thinning at narrow widths, bar width scaling at both bucket-
  count extremes (daily/many vs. yearly/few)

## Implementation Phases

1. **Backend** (done 2026-07-06): BQL-subset lexer/parser/compiler/executor
   + `POST /ledger:query` + tests; ADR 0011.
2. **Mobile** (done 2026-07-08): query plumbing, `AccountChartCard` on the
   home screen, drawer Accounts entry + picker closed-toggle, doctor
   overlay (assertion bands + picker indicators).

## Findings From The First Real-Ledger Run (2026-07-06)

Verified against the full personal ledger (~20 000 postings, 208 accounts)
re-imported from `scukas.beancount`, with beanquery running on the same file:

- balances, journals, subtree sums, and explicit-date conversions match
  beanquery exactly (to the penny, including inverse-pair rates); typical
  query latency 6–40 ms
- `count(*)` over the whole ledger differs by 8 postings in years affected
  by beancount load errors: the loader mutates/drops a few problematic
  entries while the importer stores them verbatim — a data-ingestion
  nuance, not a query-engine difference
- **transitive conversion was a real gap** (closed 2026-07-07): stock
  commodities (e.g. ESGV) are only priced in USD, so `convert(..., 'CHF')`
  yielded `null` where beanquery converts via the USD cost currency. Now
  handled by the single-intermediate-hop price lookup (parity-tested in
  `test_transitive_conversion_matches`). Decision (2026-07-07): `null` +
  `missing_price` warning stays, on the condition that frontends visibly
  display the warning; a fallback to another display currency for
  unconvertible entries is tracked on the roadmap.

## Risks / Notes

- **Price coverage** drives converted-curve quality; the Yahoo Finance
  importer exists but history may be sparse. Warnings surface gaps instead
  of failing the whole chart.
- **Performance**: monthly GROUP BY over a family-scale ledger is trivial;
  the `OPEN ON` seed adds one aggregate query. No pagination needed at v1
  caps.
- **Deliberately out of v1**: full `FROM` boolean filters, `CLEAR`,
  OR conditions, tags/links filters, `ORDER BY`/`LIMIT`/`DISTINCT`/`PIVOT`,
  multi-hop price paths (single intermediate hop is implemented),
  cost/lot columns (`cost(position)`,
  `units(position)`), user-facing query console. The AST/whitelist design
  leaves room for all of these while staying inside BQL's vocabulary.
- **Weekly/quarterly bucket granularity** is not implemented — only
  `year`/`month`/`day` bucket functions exist server-side (`compiler.py`'s
  `_BUCKET_FUNCTIONS`); the mobile granularity picker offers only
  Day/Month/Year for the same reason. Both backend (a new bucket function)
  and client (`Granularity` enum, bucket math in `chart_series.dart`,
  picker chip) work would be needed.
- **Raw/converted toggle for single-currency series**: prototyped
  (2026-07-09) as a "≈ CHF" chip next to the granularity row, then
  deliberately removed — a single already-displayed currency toggling to
  itself-converted wasn't judged useful. If revisited, the toggle likely
  belongs on the *multi*-currency case instead (today always forced into
  the combined converted view with no way back to a raw per-currency
  breakdown).
- **Home-screen balance-sheet chart** (Assets − Liabilities, with a toggle
  to a cash-flow view of Expenses + Income) is deferred. `AccountChartCard`
  is single-account-shaped end to end, so this needs its own widget; the
  recommended approach nets/sums two or more separate subtree queries
  client-side (BQL's `WHERE` still has no `OR` combinator) rather than a
  hand-built alternation regex. No doctor overlay planned for it initially.
