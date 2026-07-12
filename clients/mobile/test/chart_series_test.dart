import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/bql.dart';
import 'package:family_ledger_mobile/core/chart_series.dart';
import 'package:family_ledger_mobile/models/query_result.dart';

QueryResult _amountResult(List<List<Object?>> rows, {int keyCount = 2}) {
  final keyNames = ['y', 'm', 'd'];
  return QueryResult(
    columns: [
      for (var i = 0; i < keyCount; i++)
        QueryColumnDef(name: keyNames[i], type: 'int'),
      const QueryColumnDef(name: 'bal', type: 'amount'),
    ],
    rows: rows,
    warnings: const [],
  );
}

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

    test('empty result yields an empty series', () {
      final series = buildConvertedSeries(
        _amountResult([]),
        Granularity.monthly,
        currency: 'CHF',
        cumulative: true,
      );
      expect(series.isEmpty, isTrue);
    });
  });

  group('yearly and daily bucket sequences', () {
    test('yearly rows produce contiguous years', () {
      final series = buildConvertedSeries(
        _amountResult([
          [2023, const QueryAmount(number: '100', currency: 'CHF')],
          [2026, const QueryAmount(number: '400', currency: 'CHF')],
        ], keyCount: 1),
        Granularity.yearly,
        currency: 'CHF',
        cumulative: true,
      );
      expect(series.buckets.map((b) => b.start), [
        DateTime(2023),
        DateTime(2024),
        DateTime(2025),
        DateTime(2026),
      ]);
      expect(series.values, [100, 100, 100, 400]);
    });

    test('daily rows produce contiguous days across month ends', () {
      final series = buildConvertedSeries(
        _amountResult([
          [2026, 2, 27, const QueryAmount(number: '10', currency: 'CHF')],
          [2026, 3, 1, const QueryAmount(number: '30', currency: 'CHF')],
        ], keyCount: 3),
        Granularity.daily,
        currency: 'CHF',
        cumulative: true,
      );
      expect(series.buckets.map((b) => b.start), [
        DateTime(2026, 2, 27),
        DateTime(2026, 2, 28),
        DateTime(2026, 3),
      ]);
    });
  });
}
