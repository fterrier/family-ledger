import 'bql.dart';
import '../models/query_result.dart';

/// Pure assembly of /ledger:query results into chart-ready series.
///
/// Kept free of Flutter imports so bucket math, gap filling, and sign
/// handling are plain unit-testable functions.

class ChartBucket {
  final DateTime start;
  final DateTime end; // inclusive last day of the bucket

  const ChartBucket(this.start, this.end);

  @override
  bool operator ==(Object other) =>
      other is ChartBucket && other.start == start && other.end == end;

  @override
  int get hashCode => Object.hash(start, end);

  @override
  String toString() => 'ChartBucket($start..$end)';
}

ChartBucket bucketAt(DateTime start, Granularity granularity) =>
    switch (granularity) {
      Granularity.yearly => ChartBucket(start, DateTime(start.year, 12, 31)),
      // Day 0 of the next month is the last day of this month.
      Granularity.monthly => ChartBucket(
        start,
        DateTime(start.year, start.month + 1, 0),
      ),
      Granularity.daily => ChartBucket(start, start),
    };

DateTime nextBucketStart(DateTime start, Granularity granularity) =>
    switch (granularity) {
      Granularity.yearly => DateTime(start.year + 1),
      Granularity.monthly => DateTime(start.year, start.month + 1),
      Granularity.daily => DateTime(start.year, start.month, start.day + 1),
    };

DateTime _rowBucketStart(List<Object?> row, Granularity granularity) =>
    switch (granularity) {
      Granularity.yearly => DateTime(row[0] as int),
      Granularity.monthly => DateTime(row[0] as int, row[1] as int),
      Granularity.daily => DateTime(
        row[0] as int,
        row[1] as int,
        row[2] as int,
      ),
    };

/// Single-currency (converted) series; null values are price gaps.
class ConvertedChartSeries {
  final List<ChartBucket> buckets;
  final String currency;
  final List<double?> values;

  const ConvertedChartSeries({
    required this.buckets,
    required this.currency,
    required this.values,
  });

  bool get isEmpty => buckets.isEmpty;
}

Map<DateTime, T> _rowsByBucket<T>(
  QueryResult result,
  Granularity granularity,
  T Function(Object? cell) decode,
) {
  final valueIndex = result.columns.length - 1;
  return {
    for (final row in result.rows)
      _rowBucketStart(row, granularity): decode(row[valueIndex]),
  };
}

List<DateTime> _continuousBucketStarts(
  Iterable<DateTime> present,
  Granularity granularity,
) {
  if (present.isEmpty) return const [];
  final sorted = present.toList()..sort();
  final starts = <DateTime>[];
  var cursor = sorted.first;
  final last = sorted.last;
  while (!cursor.isAfter(last)) {
    starts.add(cursor);
    cursor = nextBucketStart(cursor, granularity);
  }
  return starts;
}

double? _decodeAmountCell(Object? cell) {
  final amount = cell as QueryAmount?;
  return amount == null ? null : double.parse(amount.number);
}

/// Decodes an opening-balance query (see bql.dart's openingBalanceQuery):
/// GROUP BY year, CLOSE ON some date, no lower bound. Buckets with no
/// activity produce no row at all (see reporting-query.md), so the
/// chronologically latest present row is the running balance carried
/// forward to the query's CLOSE ON boundary — i.e. the true balance
/// immediately before that date. Null when there's no prior activity at
/// all (no rows).
double? decodeLatestYearlyBalance(QueryResult result) {
  int? latestYear;
  double? latestValue;
  for (final row in result.rows) {
    // One malformed/unexpectedly-shaped row (e.g. a caller accidentally
    // routing a bucketed series result here) must not blow up the whole
    // decode — skip just that row, same as elsewhere in this codebase
    // (DoctorIssue._parseIssues).
    final int year;
    final double? value;
    try {
      year = row[0] as int;
      value = _decodeAmountCell(row[1]);
    } catch (_) {
      continue;
    }
    if (value == null) continue;
    if (latestYear == null || year > latestYear) {
      latestYear = year;
      latestValue = value;
    }
  }
  return latestValue;
}

/// Converted (single-currency) series from amount cells. For [cumulative]
/// series, activity gaps carry the last value forward; missing-price nulls
/// stay null (rendered as chart gaps). Bar series zero-fill gaps and keep
/// raw ledger signs (income and net savings plot negative).
ConvertedChartSeries buildConvertedSeries(
  QueryResult result,
  Granularity granularity, {
  required String currency,
  required bool cumulative,
}) {
  final byBucket = _rowsByBucket(result, granularity, _decodeAmountCell);
  final starts = _continuousBucketStarts(byBucket.keys, granularity);

  final values = <double?>[];
  double? carried;
  for (final start in starts) {
    if (byBucket.containsKey(start)) {
      final v = byBucket[start];
      if (cumulative) {
        // A missing-price null is a gap AND poisons the carry: buckets with
        // no activity after an unknown balance are unknown too.
        carried = v;
        values.add(v);
      } else {
        values.add(v ?? 0.0);
      }
    } else {
      values.add(cumulative ? carried : 0.0);
    }
  }
  return ConvertedChartSeries(
    buckets: [for (final s in starts) bucketAt(s, granularity)],
    currency: currency,
    values: values,
  );
}
