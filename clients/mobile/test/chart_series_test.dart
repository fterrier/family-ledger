import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/bql.dart';
import 'package:family_ledger_mobile/core/chart_series.dart';
import 'package:family_ledger_mobile/models/query_result.dart';

QueryResult _inventoryResult(List<List<Object?>> rows, {int keyCount = 2}) {
  final keyNames = ['y', 'm', 'd'];
  return QueryResult(
    columns: [
      for (var i = 0; i < keyCount; i++)
        QueryColumnDef(name: keyNames[i], type: 'int'),
      const QueryColumnDef(name: 'bal', type: 'inventory'),
    ],
    rows: rows,
    warnings: const [],
  );
}

QueryResult _amountResult(List<List<Object?>> rows) => QueryResult(
  columns: const [
    QueryColumnDef(name: 'y', type: 'int'),
    QueryColumnDef(name: 'm', type: 'int'),
    QueryColumnDef(name: 'bal', type: 'amount'),
  ],
  rows: rows,
  warnings: const [],
);

List<QueryAmount> inv(Map<String, String> amounts) => [
  for (final e in amounts.entries)
    QueryAmount(number: e.value, currency: e.key),
];

void main() {
  group('bucketAt', () {
    test('monthly bucket ends on the last day of the month', () {
      expect(
        bucketAt(DateTime(2026, 2), Granularity.monthly),
        ChartBucket(DateTime(2026, 2), DateTime(2026, 2, 28)),
      );
      expect(
        bucketAt(DateTime(2024, 2), Granularity.monthly),
        ChartBucket(DateTime(2024, 2), DateTime(2024, 2, 29)),
      );
    });

    test('yearly bucket ends on Dec 31', () {
      expect(
        bucketAt(DateTime(2025), Granularity.yearly),
        ChartBucket(DateTime(2025), DateTime(2025, 12, 31)),
      );
    });

    test('daily bucket is a single day', () {
      expect(
        bucketAt(DateTime(2026, 3, 5), Granularity.daily),
        ChartBucket(DateTime(2026, 3, 5), DateTime(2026, 3, 5)),
      );
    });
  });

  group('buildBalanceSeries', () {
    test('carries balances forward across empty months', () {
      final series = buildBalanceSeries(
        _inventoryResult([
          [
            2025,
            7,
            inv({'CHF': '5800'}),
          ],
          [
            2025,
            10,
            inv({'CHF': '4000'}),
          ],
        ]),
        Granularity.monthly,
      );

      expect(series.buckets.map((b) => b.start), [
        DateTime(2025, 7),
        DateTime(2025, 8),
        DateTime(2025, 9),
        DateTime(2025, 10),
      ]);
      expect(series.valuesByCurrency['CHF'], [5800, 5800, 5800, 4000]);
    });

    test('a currency is null before it first appears, then carried', () {
      final series = buildBalanceSeries(
        _inventoryResult([
          [
            2025,
            7,
            inv({'CHF': '5800'}),
          ],
          [
            2025,
            8,
            inv({'CHF': '4000', 'USD': '50'}),
          ],
          [
            2025,
            10,
            inv({'CHF': '4100', 'USD': '50'}),
          ],
        ]),
        Granularity.monthly,
      );

      expect(series.currencies, ['CHF', 'USD']);
      expect(series.valuesByCurrency['USD'], [null, 50, 50, 50]);
    });

    test('empty result yields an empty series', () {
      final series = buildBalanceSeries(
        _inventoryResult([]),
        Granularity.monthly,
      );
      expect(series.isEmpty, isTrue);
    });
  });

  group('buildTotalsSeries', () {
    test('zero-fills gaps and uses magnitudes for income', () {
      final series = buildTotalsSeries(
        _inventoryResult([
          [
            2025,
            7,
            inv({'CHF': '-5000'}),
          ],
          [
            2025,
            9,
            inv({'CHF': '-5200'}),
          ],
        ]),
        Granularity.monthly,
      );

      expect(series.valuesByCurrency['CHF'], [5000, 0.0, 5200]);
    });
  });

  group('buildConvertedSeries', () {
    test('cumulative: activity gaps carry forward, price gaps stay null', () {
      final series = buildConvertedSeries(
        _amountResult([
          [2025, 7, const QueryAmount(number: '5800', currency: 'CHF')],
          [2025, 9, null], // missing price
          [2025, 11, const QueryAmount(number: '4100', currency: 'CHF')],
        ]),
        Granularity.monthly,
        currency: 'CHF',
        cumulative: true,
      );

      expect(series.values, [
        5800, // Jul: known
        5800, // Aug: no activity -> carried
        null, // Sep: missing price -> gap
        null, // Oct: no activity after unknown -> still unknown
        4100, // Nov: known again
      ]);
    });

    test('bars: gaps zero-filled, magnitudes, null treated as zero', () {
      final series = buildConvertedSeries(
        _amountResult([
          [2025, 7, const QueryAmount(number: '-120', currency: 'CHF')],
          [2025, 9, null],
        ]),
        Granularity.monthly,
        currency: 'CHF',
        cumulative: false,
      );

      expect(series.values, [120, 0.0, 0.0]);
    });
  });

  group('yearly and daily bucket sequences', () {
    test('yearly rows produce contiguous years', () {
      final series = buildBalanceSeries(
        _inventoryResult([
          [
            2023,
            inv({'CHF': '100'}),
          ],
          [
            2026,
            inv({'CHF': '400'}),
          ],
        ], keyCount: 1),
        Granularity.yearly,
      );
      expect(series.buckets.map((b) => b.start), [
        DateTime(2023),
        DateTime(2024),
        DateTime(2025),
        DateTime(2026),
      ]);
      expect(series.valuesByCurrency['CHF'], [100, 100, 100, 400]);
    });

    test('daily rows produce contiguous days across month ends', () {
      final series = buildBalanceSeries(
        _inventoryResult([
          [
            2026,
            2,
            27,
            inv({'CHF': '10'}),
          ],
          [
            2026,
            3,
            1,
            inv({'CHF': '30'}),
          ],
        ], keyCount: 3),
        Granularity.daily,
      );
      expect(series.buckets.map((b) => b.start), [
        DateTime(2026, 2, 27),
        DateTime(2026, 2, 28),
        DateTime(2026, 3),
      ]);
    });
  });
}
