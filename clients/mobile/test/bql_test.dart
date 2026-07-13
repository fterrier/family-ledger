import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/bql.dart';

void main() {
  group('granularityForSpan', () {
    final now = DateTime(2026, 7, 8);

    test('unbounded start is yearly', () {
      expect(granularityForSpan(null, null, now: now), Granularity.yearly);
      expect(
        granularityForSpan(null, DateTime(2026, 3, 31), now: now),
        Granularity.yearly,
      );
    });

    test('up to ~4 months is daily', () {
      expect(
        granularityForSpan(DateTime(2026, 3), DateTime(2026, 6, 30), now: now),
        Granularity.daily,
      );
    });

    test('up to ~4 years is monthly', () {
      expect(
        granularityForSpan(DateTime(2025), DateTime(2025, 12, 31), now: now),
        Granularity.monthly,
      );
      expect(
        granularityForSpan(
          DateTime(2022, 7, 9),
          DateTime(2026, 7, 8),
          now: now,
        ),
        Granularity.monthly,
      );
    });

    test('longer spans are yearly', () {
      expect(
        granularityForSpan(DateTime(2019), DateTime(2026, 7, 8), now: now),
        Granularity.yearly,
      );
    });

    test('open end date measures against now', () {
      expect(
        granularityForSpan(DateTime(2026, 6), null, now: now),
        Granularity.daily,
      );
    });
  });

  group('subtreePattern', () {
    test('plain account names keep the server LIKE fast path shape', () {
      expect(
        subtreePattern(['Assets:Checking:ZKB']),
        r'^Assets:Checking:ZKB(:|$)',
      );
    });

    test('regex metacharacters are escaped', () {
      expect(subtreePattern(['Assets:A+B']), r'^Assets:A\+B(:|$)');
    });

    test('multiple roots produce the server alternation fast path shape', () {
      expect(
        subtreePattern(['Assets', 'Liabilities']),
        r'^(Assets|Liabilities)(:|$)',
      );
    });

    test('regex metacharacters are escaped inside alternations', () {
      expect(
        subtreePattern(['Assets:A+B', 'Liabilities']),
        r'^(Assets:A\+B|Liabilities)(:|$)',
      );
    });
  });

  group('balanceSeriesQuery', () {
    test(
      'monthly with both bounds seeds via OPEN ON and caps via CLOSE ON',
      () {
        expect(
          balanceSeriesQuery(
            accountNames: ['Assets:Checking:ZKB'],
            granularity: Granularity.monthly,
            from: DateTime(2025, 7),
            to: DateTime(2026, 6, 30),
          ),
          'SELECT year(date) AS y, month(date) AS m, last(balance) AS bal'
          ' FROM OPEN ON 2025-07-01 CLOSE ON 2026-07-01'
          " WHERE account ~ '^Assets:Checking:ZKB(:|\$)'"
          ' GROUP BY y, m',
        );
      },
    );

    test('unbounded yearly query has no FROM clause', () {
      expect(
        balanceSeriesQuery(
          accountNames: ['Assets:Checking:ZKB'],
          granularity: Granularity.yearly,
        ),
        'SELECT year(date) AS y, last(balance) AS bal'
        " WHERE account ~ '^Assets:Checking:ZKB(:|\$)'"
        ' GROUP BY y',
      );
    });

    test('single-currency filter adds a currency condition', () {
      expect(
        balanceSeriesQuery(
          accountNames: ['Assets:Checking:ZKB'],
          granularity: Granularity.monthly,
          currency: 'USD',
        ),
        'SELECT year(date) AS y, month(date) AS m, last(balance) AS bal'
        " WHERE account ~ '^Assets:Checking:ZKB(:|\$)' AND currency = 'USD'"
        ' GROUP BY y, m',
      );
    });

    test('converted view wraps last(balance) in convert()', () {
      expect(
        balanceSeriesQuery(
          accountNames: ['Assets:Liquid:IBKR'],
          granularity: Granularity.monthly,
          convertTo: 'CHF',
        ),
        'SELECT year(date) AS y, month(date) AS m,'
        " convert(last(balance), 'CHF') AS bal"
        " WHERE account ~ '^Assets:Liquid:IBKR(:|\$)'"
        ' GROUP BY y, m',
      );
    });

    test('daily granularity selects day buckets', () {
      expect(
        balanceSeriesQuery(
          accountNames: ['Assets:Cash'],
          granularity: Granularity.daily,
          from: DateTime(2026, 3),
          to: DateTime(2026, 3, 31),
        ),
        'SELECT year(date) AS y, month(date) AS m, day(date) AS d,'
        ' last(balance) AS bal'
        ' FROM OPEN ON 2026-03-01 CLOSE ON 2026-04-01'
        " WHERE account ~ '^Assets:Cash(:|\$)'"
        ' GROUP BY y, m, d',
      );
    });

    test('currency filter and convertTo can combine — a single commodity, '
        'shown converted', () {
      expect(
        balanceSeriesQuery(
          accountNames: ['Assets:Liquid:IBKR'],
          granularity: Granularity.monthly,
          currency: 'USD',
          convertTo: 'CHF',
        ),
        'SELECT year(date) AS y, month(date) AS m,'
        " convert(last(balance), 'CHF') AS bal"
        " WHERE account ~ '^Assets:Liquid:IBKR(:|\$)' AND currency = 'USD'"
        ' GROUP BY y, m',
      );
    });

    test('apostrophes in account names are doubled for the BQL literal', () {
      expect(
        balanceSeriesQuery(
          accountNames: ["Assets:O'Brien"],
          granularity: Granularity.yearly,
        ),
        contains("account ~ '^Assets:O''Brien(:|\$)'"),
      );
    });

    test('multiple roots net into one series via the alternation pattern', () {
      expect(
        balanceSeriesQuery(
          accountNames: ['Assets', 'Liabilities'],
          granularity: Granularity.monthly,
          from: DateTime(2025, 7),
          to: DateTime(2026, 6, 30),
          convertTo: 'CHF',
        ),
        'SELECT year(date) AS y, month(date) AS m,'
        " convert(last(balance), 'CHF') AS bal"
        ' FROM OPEN ON 2025-07-01 CLOSE ON 2026-07-01'
        " WHERE account ~ '^(Assets|Liabilities)(:|\$)'"
        ' GROUP BY y, m',
      );
    });
  });

  group('periodTotalsQuery', () {
    test('monthly bars use plain date bounds, not OPEN ON', () {
      expect(
        periodTotalsQuery(
          accountNames: ['Expenses:Family:FoodWineHousehold'],
          granularity: Granularity.monthly,
          from: DateTime(2025, 7),
          to: DateTime(2026, 6, 30),
        ),
        'SELECT year(date) AS y, month(date) AS m, sum(position) AS total'
        " WHERE account ~ '^Expenses:Family:FoodWineHousehold(:|\$)'"
        ' AND date >= 2025-07-01 AND date < 2026-07-01'
        ' GROUP BY y, m',
      );
    });

    test('converted bars wrap sum(position)', () {
      expect(
        periodTotalsQuery(
          accountNames: ['Expenses:Travel'],
          granularity: Granularity.yearly,
          convertTo: 'CHF',
        ),
        'SELECT year(date) AS y,'
        " convert(sum(position), 'CHF') AS total"
        " WHERE account ~ '^Expenses:Travel(:|\$)'"
        ' GROUP BY y',
      );
    });

    test('currency filter and convertTo can combine — a single commodity, '
        'shown converted', () {
      expect(
        periodTotalsQuery(
          accountNames: ['Expenses:Travel'],
          granularity: Granularity.yearly,
          currency: 'USD',
          convertTo: 'CHF',
        ),
        'SELECT year(date) AS y,'
        " convert(sum(position), 'CHF') AS total"
        " WHERE account ~ '^Expenses:Travel(:|\$)' AND currency = 'USD'"
        ' GROUP BY y',
      );
    });

    test('multiple roots net per bucket via the alternation pattern', () {
      expect(
        periodTotalsQuery(
          accountNames: ['Income', 'Expenses'],
          granularity: Granularity.monthly,
          from: DateTime(2025, 7),
          to: DateTime(2026, 6, 30),
          convertTo: 'CHF',
        ),
        'SELECT year(date) AS y, month(date) AS m,'
        " convert(sum(position), 'CHF') AS total"
        " WHERE account ~ '^(Income|Expenses)(:|\$)'"
        ' AND date >= 2025-07-01 AND date < 2026-07-01'
        ' GROUP BY y, m',
      );
    });
  });
}
