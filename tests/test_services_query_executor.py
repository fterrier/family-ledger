from __future__ import annotations

from typing import cast

import pytest
from query_helpers import STANDARD_PRICES, STANDARD_TRANSACTIONS, build_session
from sqlalchemy.exc import DataError
from sqlalchemy.orm import Session

from family_ledger.api.schemas import QueryColumn
from family_ledger.services.errors import ValidationError
from family_ledger.services.query import executor as executor_module
from family_ledger.services.query.executor import execute_query

# Standard ledger + USD->CHF prices (0.85 on 2025-07-10, 0.80 on 2025-08-10)
# come from query_helpers, shared with the compiler suite.


@pytest.fixture
def session() -> Session:
    return build_session(STANDARD_TRANSACTIONS, STANDARD_PRICES)


# Query fragments shared by the balance-series tests.
SELECT_YM = "SELECT year(date) AS y, month(date) AS m,"
OPEN_JUL = " FROM OPEN ON 2025-07-01"
ZKB_WHERE = " WHERE account ~ '^Assets:Checking:ZKB(:|$)'"
GROUP_YM = " GROUP BY y, m"

BALANCE_QUERY = f"{SELECT_YM} last(balance) AS bal{OPEN_JUL}{ZKB_WHERE}{GROUP_YM}"
WEIGHT_CONVERTED_QUERY = (
    f"{SELECT_YM} convert(last(balance), 'CHF') AS bal{OPEN_JUL}{ZKB_WHERE}{GROUP_YM}"
)
WEIGHT_CONVERTED_NO_OPEN_QUERY = (
    f"{SELECT_YM} convert(last(balance), 'CHF') AS bal{ZKB_WHERE}{GROUP_YM}"
)


def amount(number: str, currency: str) -> dict[str, str]:
    return {"number": number, "currency": currency}


# ---------------------------------------------------------------------------
# Running balance and folding
# ---------------------------------------------------------------------------


def test_balance_line_single_currency(session: Session) -> None:
    result = execute_query(
        session,
        f"{SELECT_YM} last(balance) AS bal{OPEN_JUL}{ZKB_WHERE} AND currency = 'CHF'{GROUP_YM}",
    )
    assert result.columns == [
        QueryColumn(name="y", type="int"),
        QueryColumn(name="m", type="int"),
        QueryColumn(name="bal", type="inventory"),
    ]
    assert result.rows == [
        [2025, 7, [amount("5800", "CHF")]],
        [2025, 8, [amount("4000", "CHF")]],
    ]
    assert result.warnings == []


def test_running_balance_carries_all_currencies(session: Session) -> None:
    result = execute_query(session, BALANCE_QUERY)
    # August moved in both currencies; the row carries the full inventory,
    # sorted by currency.
    assert result.rows == [
        [2025, 7, [amount("5800", "CHF")]],
        [2025, 8, [amount("4000", "CHF"), amount("50", "USD")]],
    ]


def test_running_balance_without_open_on_starts_at_zero(session: Session) -> None:
    result = execute_query(session, f"{SELECT_YM} last(balance) AS bal{ZKB_WHERE}{GROUP_YM}")
    assert result.rows == [
        [2025, 5, [amount("1000", "CHF")]],
        [2025, 7, [amount("5800", "CHF")]],
        [2025, 8, [amount("4000", "CHF"), amount("50", "USD")]],
    ]


# ---------------------------------------------------------------------------
# Multi-root subtree alternation (home-screen balance sheet / income statement)
# ---------------------------------------------------------------------------

# Assets +1000 in Jul; Liabilities -200 in Aug; AssetsX proves the root
# boundary (must never match the Assets subtree); Equity is excluded from
# both home views by construction.
MULTI_ROOT_TRANSACTIONS = [
    ("2025-07-05", [("Assets:Checking", "1000", "CHF"), ("Income:Salary", "-1000", "CHF")]),
    ("2025-08-10", [("Liabilities:Card", "-200", "CHF"), ("Expenses:Stuff", "200", "CHF")]),
    ("2025-09-01", [("AssetsX:Other", "999", "CHF"), ("Equity:Opening", "-999", "CHF")]),
]


@pytest.fixture
def multi_root_session() -> Session:
    return build_session(MULTI_ROOT_TRANSACTIONS)


def test_net_worth_line_nets_assets_and_liabilities(multi_root_session: Session) -> None:
    result = execute_query(
        multi_root_session,
        f"{SELECT_YM} last(balance) AS bal WHERE account ~ '^(Assets|Liabilities)(:|$)'{GROUP_YM}",
    )
    # Jul: assets 1000; Aug: 1000 + (-200) = 800 net worth. No Sep row:
    # AssetsX is outside both subtrees.
    assert result.rows == [
        [2025, 7, [amount("1000", "CHF")]],
        [2025, 8, [amount("800", "CHF")]],
    ]


def test_income_statement_nets_income_and_expenses_per_bucket(
    multi_root_session: Session,
) -> None:
    result = execute_query(
        multi_root_session,
        f"{SELECT_YM} sum(position) AS total WHERE account ~ '^(Income|Expenses)(:|$)'{GROUP_YM}",
    )
    assert result.rows == [
        [2025, 7, [amount("-1000", "CHF")]],
        [2025, 8, [amount("200", "CHF")]],
    ]


def test_multi_root_open_on_seeds_netted_balance(multi_root_session: Session) -> None:
    result = execute_query(
        multi_root_session,
        f"{SELECT_YM} last(balance) AS bal"
        " FROM OPEN ON 2025-08-01"
        " WHERE account ~ '^(Assets|Liabilities)(:|$)'"
        f"{GROUP_YM}",
    )
    # The seed carries July's netted 1000 into August's running balance.
    assert result.rows == [[2025, 8, [amount("800", "CHF")]]]


def test_multi_root_open_on_seeds_distinct_per_account_balance(
    multi_root_session: Session,
) -> None:
    result = execute_query(
        multi_root_session,
        f"{SELECT_YM} account, last(balance) AS bal"
        " FROM OPEN ON 2025-08-01"
        " WHERE account ~ '^(Assets|Liabilities)(:|$)'"
        " GROUP BY y, m, account",
    )
    # Partitioned by account instead of netted: Assets carries its own July
    # seed (1000) forward untouched by Liabilities' August activity, and
    # Liabilities starts from its own (zero) seed to see only its -200.
    assert result.rows == [
        [2025, 8, "Assets:Checking", [amount("1000", "CHF")]],
        [2025, 8, "Liabilities:Card", [amount("-200", "CHF")]],
    ]


def test_running_balance_partitions_on_two_scalar_keys_at_once(session: Session) -> None:
    # An unusual but legal combination - GROUP BY both the literal account
    # AND its account_root - exercises partition_count > 1 (merge_key,
    # partition-tuple sorting, and dormant synthesis all need to handle an
    # arbitrary number of partition positions, not just one).
    result = execute_query(
        session,
        f"{SELECT_YM} account, account_root(account) AS root, last(balance) AS bal"
        f"{OPEN_JUL}{ZKB_WHERE}"
        " GROUP BY y, m, account, root",
    )
    assert result.rows == [
        [2025, 7, "Assets:Checking:ZKB", "Assets:Checking:ZKB", [amount("5800", "CHF")]],
        [2025, 8, "Assets:Checking:ZKB", "Assets:Checking:ZKB", [amount("4000", "CHF")]],
        [2025, 8, "Assets:Checking:ZKB:Sub", "Assets:Checking:ZKB", [amount("50", "USD")]],
    ]


def test_dormant_window_with_nonzero_seed_returns_one_flat_bucket(session: Session) -> None:
    # No postings at all in Jan 2026, but the account holds a nonzero
    # balance as of the OPEN ON date — the window must not read as empty.
    result = execute_query(
        session,
        f"{SELECT_YM} last(balance) AS bal"
        " FROM OPEN ON 2026-01-01 CLOSE ON 2026-02-01"
        f"{ZKB_WHERE}{GROUP_YM}",
    )
    assert result.rows == [[2026, 1, [amount("4000", "CHF"), amount("50", "USD")]]]


def test_dormant_window_with_seed_netting_to_zero_stays_empty(session: Session) -> None:
    # A partition can have real activity before the window (so the seed
    # select does produce a row for it) that nonetheless nets to exactly
    # zero - the account was fully drained before the queried window even
    # starts. That must not synthesize a spurious empty-inventory bucket,
    # same as an account with no seed row at all.
    zeroed_session = build_session(
        [
            ("2025-01-01", [("Assets:Zeroed", "500", "CHF"), ("Equity:Opening", "-500", "CHF")]),
            ("2025-02-01", [("Assets:Zeroed", "-500", "CHF"), ("Equity:Opening", "500", "CHF")]),
        ]
    )
    result = execute_query(
        zeroed_session,
        f"{SELECT_YM} last(balance) AS bal"
        " FROM OPEN ON 2025-07-01 CLOSE ON 2025-08-01"
        " WHERE account ~ '^Assets:Zeroed(:|$)'"
        f"{GROUP_YM}",
    )
    assert result.rows == []


def test_dormant_window_with_mixed_active_and_dormant_partitions() -> None:
    # Two accounts share a seed balance as of the window start; only one of
    # them posts again inside the window. Each partition must synthesize (or
    # not) its own dormant bucket independently of the other's activity.
    mixed_session = build_session(
        [
            ("2025-01-01", [("Assets:A", "1000", "CHF"), ("Equity:Opening", "-1000", "CHF")]),
            ("2025-01-01", [("Assets:B", "500", "CHF"), ("Equity:Opening", "-500", "CHF")]),
            ("2025-03-15", [("Assets:A", "200", "CHF"), ("Equity:Opening", "-200", "CHF")]),
        ]
    )
    result = execute_query(
        mixed_session,
        f"{SELECT_YM} account, last(balance) AS bal"
        " FROM OPEN ON 2025-03-01 CLOSE ON 2025-04-01"
        " WHERE account ~ '^(Assets:A|Assets:B)(:|$)'"
        " GROUP BY y, m, account",
    )
    assert result.rows == [
        [2025, 3, "Assets:A", [amount("1200", "CHF")]],
        [2025, 3, "Assets:B", [amount("500", "CHF")]],
    ]


def test_dormant_window_with_zero_seed_stays_empty(session: Session) -> None:
    # A dormant window with NO prior balance at all (account never touched
    # before the window) must still report no rows, not a synthetic zero.
    result = execute_query(
        session,
        f"{SELECT_YM} last(balance) AS bal"
        " FROM OPEN ON 2020-01-01 CLOSE ON 2020-02-01"
        f"{ZKB_WHERE}{GROUP_YM}",
    )
    assert result.rows == []


def test_dormant_window_converted_view_also_flattens(session: Session) -> None:
    result = execute_query(
        session,
        f"{SELECT_YM} convert(last(balance), 'CHF') AS bal"
        " FROM OPEN ON 2026-01-01 CLOSE ON 2026-02-01"
        f"{ZKB_WHERE}{GROUP_YM}",
    )
    # The synthetic bucket converts exactly like a live one: 2025-08-10's
    # 0.80 rate is still the latest USD price on or before the bucket end.
    assert result.rows == [[2026, 1, amount("4040", "CHF")]]
    assert result.warnings == []


# ---------------------------------------------------------------------------
# account_root() composed with partition-aware running balance
# ---------------------------------------------------------------------------


def test_account_root_with_running_balance_nets_leaf_and_parent_correctly(
    session: Session,
) -> None:
    # ZKB is a parent with a real child (ZKB:Sub, posted in August);
    # Groceries is a plain leaf with no children. Both roots share one
    # query, proving account_root() partitioning and the running-balance
    # accumulator compose correctly: each root nets its own postings
    # (leaf-only or parent+child) independently, with no seed at all for
    # Groceries (its first-ever posting is inside the window).
    result = execute_query(
        session,
        f"{SELECT_YM} account_root(account) AS root, last(balance) AS bal"
        " FROM OPEN ON 2025-07-01"
        " WHERE account ~ '^(Assets:Checking:ZKB|Expenses:Groceries)(:|$)'"
        " GROUP BY y, m, root",
    )
    # Rows stay ordered by group keys ascending (y, m, root) - chronological
    # first, root as the tie-break within a month - not grouped by root.
    assert result.rows == [
        [2025, 7, "Assets:Checking:ZKB", [amount("5800", "CHF")]],
        [2025, 7, "Expenses:Groceries", [amount("200", "CHF")]],
        [2025, 8, "Assets:Checking:ZKB", [amount("4000", "CHF"), amount("50", "USD")]],
        [2025, 8, "Expenses:Groceries", [amount("500", "CHF")]],
    ]


def test_account_root_with_running_balance_and_convert_composes(session: Session) -> None:
    # convert() is applied after partition accumulation is complete, keyed
    # by the same (bucket, partition) tuples - proves that pipeline stage
    # doesn't need (and doesn't have) any partition-specific logic of its
    # own, unlike the accumulation step itself.
    result = execute_query(
        session,
        f"{SELECT_YM} account_root(account) AS root, convert(last(balance), 'CHF') AS bal"
        " FROM OPEN ON 2025-07-01"
        " WHERE account ~ '^(Assets:Checking:ZKB|Expenses:Groceries)(:|$)'"
        " GROUP BY y, m, root",
    )
    # ZKB's August USD position (50 x 0.80) converts on top of its own
    # partition's running CHF balance; Groceries has no USD exposure at all.
    # Rows stay ordered by group keys ascending (y, m, root).
    assert result.rows == [
        [2025, 7, "Assets:Checking:ZKB", amount("5800", "CHF")],
        [2025, 7, "Expenses:Groceries", amount("200", "CHF")],
        [2025, 8, "Assets:Checking:ZKB", amount("4040", "CHF")],
        [2025, 8, "Expenses:Groceries", amount("500", "CHF")],
    ]


def test_account_root_running_balance_with_nested_and_dormant_partitions() -> None:
    # Three roots mixing every hierarchy shape in one WHERE alternation, each
    # partitioned independently in the running balance:
    #  - "Assets:Bank:Savings": a middle node, declared FIRST so its narrower
    #    WHEN clause claims its own grandchild activity ahead of the parent.
    #  - "Assets:Bank": the parent root; only picks up postings NOT already
    #    claimed by the narrower Savings root (its own direct postings, and
    #    its Other child).
    #  - "Assets:Invested:IBKR:VTI": an unrelated plain-leaf root that is
    #    fully dormant inside the queried window but carries a nonzero seed.
    mixed_session = build_session(
        [
            # Seed period (before OPEN ON 2025-07-01).
            (
                "2025-01-01",
                [("Assets:Bank:Savings", "1000", "CHF"), ("Equity:Opening", "-1000", "CHF")],
            ),
            (
                "2025-02-01",
                [("Assets:Bank", "500", "CHF"), ("Equity:Opening", "-500", "CHF")],
            ),
            (
                "2025-03-01",
                [
                    ("Assets:Invested:IBKR:VTI", "2000", "CHF"),
                    ("Equity:Opening", "-2000", "CHF"),
                ],
            ),
            # In-window activity (Jul/Aug) - VTI is untouched.
            (
                "2025-07-10",
                [
                    ("Assets:Bank:Savings:Sub", "200", "CHF"),
                    ("Equity:Opening", "-200", "CHF"),
                ],
            ),
            (
                "2025-08-05",
                [("Assets:Bank:Other", "50", "CHF"), ("Equity:Opening", "-50", "CHF")],
            ),
        ]
    )
    result = execute_query(
        mixed_session,
        f"{SELECT_YM} account_root(account) AS root, last(balance) AS bal"
        " FROM OPEN ON 2025-07-01 CLOSE ON 2025-09-01"
        " WHERE account ~"
        " '^(Assets:Bank:Savings|Assets:Bank|Assets:Invested:IBKR:VTI)(:|$)'"
        " GROUP BY y, m, root",
    )
    # Rows stay ordered by group keys ascending (y, m, root): July's two
    # rows (real and synthetic) both precede August's, not grouped by root.
    assert result.rows == [
        [2025, 7, "Assets:Bank:Savings", [amount("1200", "CHF")]],
        # Dormant: no postings in-window at all, carried flat from its seed
        # at the OPEN ON bucket, independently of the other two partitions'
        # own activity.
        [2025, 7, "Assets:Invested:IBKR:VTI", [amount("2000", "CHF")]],
        [2025, 8, "Assets:Bank", [amount("550", "CHF")]],
    ]


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------


def test_weight_conversion_at_bucket_end(session: Session) -> None:
    # This exercises convert()'s existing cost/price-weight basis — not real
    # market value (see the value() section below for that, and its own
    # ValuePriceLookup-backed revaluation).
    result = execute_query(session, WEIGHT_CONVERTED_QUERY)
    assert result.columns[2] == QueryColumn(name="bal", type="amount")
    # August: 4000 + 50 USD x 0.80 (price of 2025-08-10, latest <= 2025-08-31).
    assert result.rows == [
        [2025, 7, amount("5800", "CHF")],
        [2025, 8, amount("4040", "CHF")],
    ]
    assert result.warnings == []


def test_conversion_with_explicit_date(session: Session) -> None:
    result = execute_query(
        session,
        f"{SELECT_YM} convert(last(balance), 'CHF', 2025-07-15) AS bal"
        f"{OPEN_JUL}{ZKB_WHERE}{GROUP_YM}",
    )
    # Every bucket converts at 2025-07-15, so USD uses 0.85: 4000 + 42.50.
    assert result.rows == [
        [2025, 7, amount("5800", "CHF")],
        [2025, 8, amount("4042.5", "CHF")],
    ]


def test_missing_price_yields_null_cell_and_warning() -> None:
    session = build_session(STANDARD_TRANSACTIONS)
    result = execute_query(session, WEIGHT_CONVERTED_QUERY)
    assert result.rows == [
        [2025, 7, amount("5800", "CHF")],
        [2025, 8, None],
    ]
    assert len(result.warnings) == 1
    warning = result.warnings[0]
    assert warning.code == "missing_price"
    assert warning.details == {"base": "USD", "quote": "CHF", "date": "2025-08-31"}


def test_zero_balance_currency_needs_no_price() -> None:
    # USD arrives and leaves within August; its balance is zero at bucket end,
    # so conversion must not demand a USD price.
    transactions = STANDARD_TRANSACTIONS + [
        (
            "2025-08-22",
            [("Assets:Checking:ZKB:Sub", "-50", "USD"), ("Equity:Opening", "50", "USD")],
        ),
    ]
    session = build_session(transactions)
    result = execute_query(session, WEIGHT_CONVERTED_QUERY)
    assert result.rows == [
        [2025, 7, amount("5800", "CHF")],
        [2025, 8, amount("4000", "CHF")],
    ]
    assert result.warnings == []


def test_inverse_pair_does_not_resolve() -> None:
    # Only CHF->EUR is stored; a price must be recorded in the direction
    # it's needed (see services/prices.py's PriceLookup).
    session = build_session(
        [
            (
                "2025-08-05",
                [("Assets:Checking:ZKB", "100", "CHF"), ("Equity:Opening", "-100", "CHF")],
            ),
            (
                "2025-08-25",
                [("Assets:Checking:ZKB", "10", "EUR"), ("Equity:Opening", "-10", "EUR")],
            ),
        ],
        prices=(("2025-08-01", "CHF", "EUR", "1.25"),),
    )
    result = execute_query(session, WEIGHT_CONVERTED_NO_OPEN_QUERY)
    assert result.rows == [[2025, 8, None]]
    assert [w.details["base"] for w in result.warnings] == ["EUR"]


def test_transitive_conversion_via_intermediate_currency() -> None:
    # VT is only priced in USD; converting to CHF requires VT->USD->CHF.
    session = build_session(
        [
            (
                "2025-08-05",
                [("Assets:Checking:ZKB", "100", "CHF"), ("Equity:Opening", "-100", "CHF")],
            ),
            (
                "2025-08-25",
                [("Assets:Checking:ZKB", "5", "VT"), ("Equity:Opening", "-5", "VT")],
            ),
        ],
        prices=(("2025-08-01", "VT", "USD", "100"), ("2025-08-10", "USD", "CHF", "0.80")),
    )
    result = execute_query(session, WEIGHT_CONVERTED_NO_OPEN_QUERY)
    # 100 CHF + 5 VT x 100 USD x 0.80 = 500
    assert result.rows == [[2025, 8, amount("500", "CHF")]]
    assert result.warnings == []


def test_direct_price_beats_transitive_path() -> None:
    session = build_session(
        [("2025-08-25", [("Assets:Checking:ZKB", "5", "VT"), ("Equity:Opening", "-5", "VT")])],
        prices=(
            ("2025-08-01", "VT", "USD", "100"),
            ("2025-08-10", "USD", "CHF", "0.80"),
            # Direct VT->CHF disagrees with the via-USD path (90 vs 80) and must win.
            ("2025-08-05", "VT", "CHF", "90"),
        ),
    )
    result = execute_query(session, WEIGHT_CONVERTED_NO_OPEN_QUERY)
    assert result.rows == [[2025, 8, amount("450", "CHF")]]


def test_transitive_conversion_does_not_use_an_inverse_leg() -> None:
    # VT->USD is a usable base leg, but the only USD-side price on file is
    # CHF->USD, not USD->CHF — the target leg has nothing to resolve
    # against, same as if it were missing entirely.
    session = build_session(
        [("2025-08-25", [("Assets:Checking:ZKB", "5", "VT"), ("Equity:Opening", "-5", "VT")])],
        prices=(("2025-08-01", "VT", "USD", "100"), ("2025-08-10", "CHF", "USD", "1.25")),
    )
    result = execute_query(session, WEIGHT_CONVERTED_NO_OPEN_QUERY)
    assert result.rows == [[2025, 8, None]]
    assert [w.details["base"] for w in result.warnings] == ["VT"]


def test_no_conversion_path_still_warns() -> None:
    # VT->USD exists but there is no USD->CHF leg: no path, null + warning.
    session = build_session(
        [("2025-08-25", [("Assets:Checking:ZKB", "5", "VT"), ("Equity:Opening", "-5", "VT")])],
        prices=(("2025-08-01", "VT", "USD", "100"),),
    )
    result = execute_query(session, WEIGHT_CONVERTED_NO_OPEN_QUERY)
    assert result.rows == [[2025, 8, None]]
    assert [w.details["base"] for w in result.warnings] == ["VT"]


# ---------------------------------------------------------------------------
# value(): market revaluation (see services/prices.py's ValuePriceLookup).
# Cross-checked against real beancount/beanquery in
# tests/test_value_beancount_parity.py — these focus on things specific to
# this engine's bucket/running-balance model instead of duplicating that
# parity coverage.
# ---------------------------------------------------------------------------


def test_value_output_column_is_inventory_typed(session: Session) -> None:
    result = execute_query(session, f"{SELECT_YM} value(sum(position)) AS v{ZKB_WHERE}{GROUP_YM}")
    assert result.columns[2] == QueryColumn(name="v", type="inventory")


def test_value_prices_each_bucket_at_its_own_end_date() -> None:
    session = build_session(
        [
            (
                "2025-07-05",
                [
                    ("Assets:Broker:VSS", "10", "VSS", {"cost_amount": "40", "cost_symbol": "CAD"}),
                    ("Equity:Opening", "-400", "CAD"),
                ],
            ),
            (
                "2025-08-05",
                [
                    ("Assets:Broker:VSS", "10", "VSS", {"cost_amount": "42", "cost_symbol": "CAD"}),
                    ("Equity:Opening", "-420", "CAD"),
                ],
            ),
        ],
        prices=(
            ("2025-07-10", "VSS", "CAD", "45"),
            ("2025-08-10", "VSS", "CAD", "50"),
        ),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} value(sum(position)) AS v WHERE account ~ '^Assets:Broker(:|$)'{GROUP_YM}",
    )
    # Each bucket's 10 VSS purchase revalues at that bucket's own end-of-
    # month price — July at 45, August at 50 — not a single query-wide date.
    assert result.rows == [
        [2025, 7, [amount("450", "CAD")]],
        [2025, 8, [amount("500", "CAD")]],
    ]


def test_value_sums_multiple_securities_into_the_same_value_currency() -> None:
    session = build_session(
        [
            (
                "2025-07-05",
                [
                    (
                        "Assets:Broker:VSS",
                        "100",
                        "VSS",
                        {"cost_amount": "40", "cost_symbol": "CAD"},
                    ),
                    ("Equity:Opening", "-4000", "CAD"),
                ],
            ),
            (
                "2025-07-06",
                [
                    ("Assets:Broker:XYZ", "10", "XYZ", {"cost_amount": "5", "cost_symbol": "CAD"}),
                    ("Equity:Opening", "-50", "CAD"),
                ],
            ),
        ],
        prices=(
            ("2025-07-10", "VSS", "CAD", "45"),
            ("2025-07-10", "XYZ", "CAD", "6"),
        ),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} value(sum(position)) AS v WHERE account ~ '^Assets:Broker(:|$)'{GROUP_YM}",
    )
    # VSS: 100 x 45 = 4500 CAD; XYZ: 10 x 6 = 60 CAD — different securities,
    # same value_currency, must fold into one summed entry.
    assert result.rows == [[2025, 7, [amount("4560", "CAD")]]]


def test_value_revalues_the_running_total_at_each_buckets_own_price() -> None:
    session = build_session(
        [
            (
                "2025-07-05",
                [
                    ("Assets:Broker:VSS", "10", "VSS", {"cost_amount": "40", "cost_symbol": "CAD"}),
                    ("Equity:Opening", "-400", "CAD"),
                ],
            ),
            (
                "2025-08-05",
                [
                    ("Assets:Broker:VSS", "5", "VSS", {"cost_amount": "42", "cost_symbol": "CAD"}),
                    ("Equity:Opening", "-210", "CAD"),
                ],
            ),
        ],
        prices=(
            ("2025-07-10", "VSS", "CAD", "45"),
            ("2025-08-10", "VSS", "CAD", "50"),
        ),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} value(last(balance)) AS v WHERE account ~ '^Assets:Broker(:|$)'{GROUP_YM}",
    )
    # Running total accumulates first (10 VSS after July, 15 after August —
    # same rule as any other last(balance)), *then* each bucket's cumulative
    # holding revalues at that bucket's own end-of-month price.
    assert result.rows == [
        [2025, 7, [amount("450", "CAD")]],  # 10 x 45
        [2025, 8, [amount("750", "CAD")]],  # 15 x 50
    ]


def test_value_uses_a_stored_zero_price_literally() -> None:
    # A security's price legitimately can be 0 (total loss, delisting) —
    # distinct from PriceLookup's FX rates, where a stored 0 is treated as
    # degenerate data (see services/prices.py). The revalued amount is then
    # a real 0, dropped by _serialize_inventory same as any other zero
    # balance — matching beancount, which drops it too.
    session = build_session(
        [
            (
                "2022-11-02",
                [
                    (
                        "Assets:Broker:FARMY",
                        "200",
                        "FARMY",
                        {"cost_amount": "12", "cost_symbol": "CHF"},
                    ),
                    ("Equity:Opening", "-2400", "CHF"),
                ],
            ),
        ],
        prices=(("2025-01-31", "FARMY", "CHF", "0"),),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} value(last(balance)) AS v"
        " FROM OPEN ON 2025-02-01 CLOSE ON 2025-02-02"
        " WHERE account ~ '^Assets:Broker(:|$)'"
        f"{GROUP_YM}",
    )
    # Dormant-window synthetic bucket (see test_dormant_window_with_
    # nonzero_seed_returns_one_flat_bucket): still holding 200 FARMY, now
    # priced at 0 — revalues to a real 0, which drops the entry entirely
    # rather than reporting a fake "no data" gap or a misleading nonzero.
    assert result.rows == [[2025, 2, []]]


# ---------------------------------------------------------------------------
# convert(value(...)): market value revalued at market price, then
# FX-converted to a single target currency.
# ---------------------------------------------------------------------------


def test_convert_of_value_revalues_then_fx_converts() -> None:
    session = build_session(
        [
            (
                "2025-07-05",
                [
                    ("Assets:Broker:VSS", "10", "VSS", {"cost_amount": "40", "cost_symbol": "USD"}),
                    ("Equity:Opening", "-400", "USD"),
                ],
            ),
        ],
        prices=(
            ("2025-07-10", "VSS", "USD", "45"),
            ("2025-07-10", "USD", "CHF", "0.80"),
        ),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} convert(value(sum(position)), 'CHF') AS v"
        " WHERE account ~ '^Assets:Broker(:|$)'"
        f"{GROUP_YM}",
    )
    # 10 VSS x 45 USD (value()) = 450 USD, x 0.80 (convert()) = 360 CHF.
    assert result.columns[2] == QueryColumn(name="v", type="amount")
    assert result.rows == [[2025, 7, amount("360", "CHF")]]
    assert result.warnings == []


def test_convert_of_value_matches_running_balance() -> None:
    session = build_session(
        [
            (
                "2025-07-05",
                [
                    ("Assets:Broker:VSS", "10", "VSS", {"cost_amount": "40", "cost_symbol": "USD"}),
                    ("Equity:Opening", "-400", "USD"),
                ],
            ),
        ],
        prices=(
            ("2025-07-10", "VSS", "USD", "45"),
            ("2025-07-10", "USD", "CHF", "0.80"),
        ),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} convert(value(last(balance)), 'CHF') AS v"
        " WHERE account ~ '^Assets:Broker(:|$)'"
        f"{GROUP_YM}",
    )
    assert result.rows == [[2025, 7, amount("360", "CHF")]]


def test_convert_of_value_warns_when_the_fx_leg_is_missing() -> None:
    # value() resolves VSS -> USD fine; there's just no USD -> CHF price on
    # file for the outer convert() to finish the job.
    session = build_session(
        [
            (
                "2025-07-05",
                [
                    ("Assets:Broker:VSS", "10", "VSS", {"cost_amount": "40", "cost_symbol": "USD"}),
                    ("Equity:Opening", "-400", "USD"),
                ],
            ),
        ],
        prices=(("2025-07-10", "VSS", "USD", "45"),),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} convert(value(sum(position)), 'CHF') AS v"
        " WHERE account ~ '^Assets:Broker(:|$)'"
        f"{GROUP_YM}",
    )
    assert result.rows == [[2025, 7, None]]
    assert [w.details["base"] for w in result.warnings] == ["USD"]


def test_convert_of_value_reports_a_devalued_holding_as_an_explicit_zero() -> None:
    # Standalone value() drops a devalued-to-zero entry (see
    # test_value_uses_a_stored_zero_price_literally) — that's an
    # inventory-typed cell, where "no currencies left" and "no data at all"
    # look the same. convert(value(...)) is different: it's amount-typed,
    # and _convert_balances sums an empty currency dict to a real total of
    # 0 rather than treating it as a missing price, so the row stays
    # present with an explicit 0 — the mobile chart (which always sends
    # convert(value(...), 'CUR'), never bare value()) can tell "revalued to
    # true zero" apart from "no data this bucket" without extra plumbing.
    session = build_session(
        [
            (
                "2022-11-02",
                [
                    (
                        "Assets:Broker:FARMY",
                        "200",
                        "FARMY",
                        {"cost_amount": "12", "cost_symbol": "CHF"},
                    ),
                    ("Equity:Opening", "-2400", "CHF"),
                ],
            ),
        ],
        prices=(("2025-01-31", "FARMY", "CHF", "0"),),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} convert(value(last(balance)), 'CHF') AS v"
        " FROM OPEN ON 2025-02-01 CLOSE ON 2025-02-02"
        " WHERE account ~ '^Assets:Broker(:|$)'"
        f"{GROUP_YM}",
    )
    assert result.rows == [[2025, 2, amount("0", "CHF")]]
    assert result.warnings == []


def test_convert_of_value_uses_the_explicit_date_for_both_legs() -> None:
    # Two VSS prices straddle the explicit date: value() must pick the one
    # on or before it (45), not the later one bucket-end pricing would pick
    # (50, from 7-25, on or before this July bucket's own end 7-31).
    session = build_session(
        [
            (
                "2025-07-05",
                [
                    ("Assets:Broker:VSS", "10", "VSS", {"cost_amount": "40", "cost_symbol": "USD"}),
                    ("Equity:Opening", "-400", "USD"),
                ],
            ),
        ],
        prices=(
            ("2025-07-10", "VSS", "USD", "45"),
            ("2025-07-25", "VSS", "USD", "50"),
            ("2025-07-10", "USD", "CHF", "0.80"),
        ),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} convert(value(sum(position)), 'CHF', 2025-07-15) AS v"
        " WHERE account ~ '^Assets:Broker(:|$)'"
        f"{GROUP_YM}",
    )
    # 10 VSS x 45 USD (value() at 7-15, not the 7-25 price) = 450 USD,
    # x 0.80 (convert() at 7-15) = 360 CHF.
    assert result.rows == [[2025, 7, amount("360", "CHF")]]


def test_convert_of_value_passthrough_still_reaches_the_fx_leg() -> None:
    # No price at all for VSS: value() passes it through under its own
    # symbol, and convert() then needs a VSS -> CHF price directly.
    session = build_session(
        [
            (
                "2025-07-05",
                [
                    ("Assets:Broker:VSS", "10", "VSS", {"cost_amount": "40", "cost_symbol": "USD"}),
                    ("Equity:Opening", "-400", "USD"),
                ],
            ),
        ],
        prices=(("2025-07-10", "VSS", "CHF", "36"),),
    )
    result = execute_query(
        session,
        f"{SELECT_YM} convert(value(sum(position)), 'CHF') AS v"
        " WHERE account ~ '^Assets:Broker(:|$)'"
        f"{GROUP_YM}",
    )
    assert result.rows == [[2025, 7, amount("360", "CHF")]]
    assert result.warnings == []


# ---------------------------------------------------------------------------
# Plain aggregates and journal queries
# ---------------------------------------------------------------------------


def test_expense_bars_inventory(session: Session) -> None:
    result = execute_query(
        session,
        "SELECT year(date) AS y, month(date) AS m, sum(position) AS total"
        " WHERE account ~ '^Expenses:Groceries(:|$)' AND date >= 2025-07-01"
        " GROUP BY y, m",
    )
    assert result.rows == [
        [2025, 7, [amount("200", "CHF")]],
        [2025, 8, [amount("300", "CHF")]],
    ]


def test_bucket_netting_to_zero_gives_empty_inventory() -> None:
    session = build_session(
        [("2025-07-01", [("Assets:X", "25", "CHF"), ("Assets:X", "-25", "CHF")])]
    )
    result = execute_query(
        session,
        "SELECT year(date) AS y, month(date) AS m, sum(position) AS total"
        " WHERE account = 'Assets:X' GROUP BY y, m",
    )
    assert result.rows == [[2025, 7, []]]


def test_count_star_single_row(session: Session) -> None:
    result = execute_query(session, "SELECT count(*) AS n WHERE account ~ '^Expenses(:|$)'")
    assert result.columns == [QueryColumn(name="n", type="int")]
    assert result.rows == [[3]]


def test_ungrouped_sum_returns_single_row(session: Session) -> None:
    result = execute_query(
        session, "SELECT sum(position) AS total WHERE account ~ '^Expenses:Groceries(:|$)'"
    )
    assert result.rows == [[[amount("500", "CHF")]]]


def test_journal_serialization(session: Session) -> None:
    result = execute_query(
        session,
        "SELECT date, account, payee, number, currency WHERE account ~ '^Expenses:Groceries(:|$)'",
    )
    assert result.columns == [
        QueryColumn(name="date", type="date"),
        QueryColumn(name="account", type="str"),
        QueryColumn(name="payee", type="str"),
        QueryColumn(name="number", type="decimal"),
        QueryColumn(name="currency", type="str"),
    ]
    assert result.rows == [
        ["2025-07-20", "Expenses:Groceries", None, "200", "CHF"],
        ["2025-08-03", "Expenses:Groceries", None, "300", "CHF"],
    ]


# ---------------------------------------------------------------------------
# Guardrails and error propagation
# ---------------------------------------------------------------------------


def test_query_too_long_is_rejected(session: Session) -> None:
    with pytest.raises(ValidationError) as exc_info:
        execute_query(session, "SELECT account" + " " * 10_001)
    assert exc_info.value.code == "query_parse_error"


def test_row_cap_is_enforced(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(executor_module, "MAX_RESULT_ROWS", 2)
    with pytest.raises(ValidationError) as exc_info:
        execute_query(session, "SELECT date, account WHERE account ~ '^Expenses(:|$)'")
    assert exc_info.value.code == "query_result_too_large"


def test_parse_errors_propagate(session: Session) -> None:
    with pytest.raises(ValidationError) as exc_info:
        execute_query(session, "SELECT")
    assert exc_info.value.code == "query_parse_error"


def test_validation_errors_propagate(session: Session) -> None:
    with pytest.raises(ValidationError) as exc_info:
        execute_query(session, "SELECT frobnicate")
    assert exc_info.value.code == "query_validation_error"


def test_database_errors_surface_as_validation_errors() -> None:
    # Backstop for input the compiler cannot fully validate (e.g. regex
    # syntax the database dialect rejects): 400, never 500.
    class _FailingSession:
        def execute(self, statement: object) -> object:
            raise DataError("SELECT ...", {}, Exception("invalid regular expression"))

    with pytest.raises(ValidationError) as exc_info:
        execute_query(cast(Session, _FailingSession()), "SELECT count(*) AS n")
    assert exc_info.value.code == "query_validation_error"


def test_negative_number_filter(session: Session) -> None:
    result = execute_query(
        session,
        "SELECT date, number WHERE account = 'Assets:Checking:ZKB' AND number < -1000",
    )
    assert result.rows == [["2025-08-20", "-1500"]]
