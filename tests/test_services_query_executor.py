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
MARKET_VALUE_QUERY = (
    f"{SELECT_YM} convert(last(balance), 'CHF') AS bal{OPEN_JUL}{ZKB_WHERE}{GROUP_YM}"
)
MARKET_VALUE_NO_OPEN_QUERY = (
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
# Conversion
# ---------------------------------------------------------------------------


def test_market_value_conversion_at_bucket_end(session: Session) -> None:
    result = execute_query(session, MARKET_VALUE_QUERY)
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
    result = execute_query(session, MARKET_VALUE_QUERY)
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
    result = execute_query(session, MARKET_VALUE_QUERY)
    assert result.rows == [
        [2025, 7, amount("5800", "CHF")],
        [2025, 8, amount("4000", "CHF")],
    ]
    assert result.warnings == []


def test_inverse_price_fallback() -> None:
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
    result = execute_query(session, MARKET_VALUE_NO_OPEN_QUERY)
    # No EUR->CHF price; the CHF->EUR 1.25 inverts to 0.8: 100 + 10 x 0.8.
    assert result.rows == [[2025, 8, amount("108", "CHF")]]


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
    result = execute_query(session, MARKET_VALUE_NO_OPEN_QUERY)
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
    result = execute_query(session, MARKET_VALUE_NO_OPEN_QUERY)
    assert result.rows == [[2025, 8, amount("450", "CHF")]]


def test_transitive_conversion_with_inverse_second_leg() -> None:
    # VT->USD plus CHF->USD: the second leg is the inverse pair, 1 / 1.25.
    session = build_session(
        [("2025-08-25", [("Assets:Checking:ZKB", "5", "VT"), ("Equity:Opening", "-5", "VT")])],
        prices=(("2025-08-01", "VT", "USD", "100"), ("2025-08-10", "CHF", "USD", "1.25")),
    )
    result = execute_query(session, MARKET_VALUE_NO_OPEN_QUERY)
    # 5 x 100 x (1 / 1.25) = 400
    assert result.rows == [[2025, 8, amount("400", "CHF")]]


def test_no_conversion_path_still_warns() -> None:
    # VT->USD exists but there is no USD->CHF leg: no path, null + warning.
    session = build_session(
        [("2025-08-25", [("Assets:Checking:ZKB", "5", "VT"), ("Equity:Opening", "-5", "VT")])],
        prices=(("2025-08-01", "VT", "USD", "100"),),
    )
    result = execute_query(session, MARKET_VALUE_NO_OPEN_QUERY)
    assert result.rows == [[2025, 8, None]]
    assert [w.details["base"] for w in result.warnings] == ["VT"]


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
