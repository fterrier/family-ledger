import 'package:intl/intl.dart';

/// Builders for the BQL-subset queries sent to POST /ledger:query.
///
/// Keeping query construction here (pure string functions) makes the exact
/// wire format unit-testable. See docs/specs/reporting-query.md for the
/// language contract.

enum Granularity { daily, monthly, yearly }

/// Bucket granularity derived from the filter span: <= ~4 months daily,
/// <= ~4 years monthly, longer (or unbounded start) yearly.
Granularity granularityForSpan(DateTime? from, DateTime? to, {DateTime? now}) {
  if (from == null) return Granularity.yearly;
  final end = to ?? now ?? DateTime.now();
  final days = end.difference(from).inDays;
  if (days <= 124) return Granularity.daily;
  if (days <= 1461) return Granularity.monthly;
  return Granularity.yearly;
}

final DateFormat _dateFormat = DateFormat('yyyy-MM-dd');

String _date(DateTime d) => _dateFormat.format(d);

/// BQL string literal: single-quoted, embedded quotes doubled.
String _quote(String value) => "'${value.replaceAll("'", "''")}'";

/// Regex matching any of [accountNames] or any account below them. A single
/// plain name produces the exact `^literal(:|$)` shape the server compiles
/// to an indexed LIKE, several names the `^(a|b)(:|$)` alternation it
/// compiles to an OR of those clauses; names containing regex
/// metacharacters are escaped and fall back to the server's general regex
/// path.
String subtreePattern(List<String> accountNames) {
  assert(accountNames.isNotEmpty, 'subtreePattern needs at least one root');
  return accountNames.length == 1
      ? '^${RegExp.escape(accountNames.single)}(:|\$)'
      : '^(${accountNames.map(RegExp.escape).join('|')})(:|\$)';
}

String _bucketColumns(Granularity granularity) => switch (granularity) {
  Granularity.yearly => 'year(date) AS y',
  Granularity.monthly => 'year(date) AS y, month(date) AS m',
  Granularity.daily => 'year(date) AS y, month(date) AS m, day(date) AS d',
};

String _bucketKeys(Granularity granularity) => switch (granularity) {
  Granularity.yearly => 'y',
  Granularity.monthly => 'y, m',
  Granularity.daily => 'y, m, d',
};

DateTime _dayAfter(DateTime d) => DateTime(d.year, d.month, d.day + 1);

/// Running-balance series over one or more account subtrees (line chart).
///
/// Multiple [accountNames] net into a single series with raw ledger signs
/// (e.g. Assets + Liabilities = net worth). [from]/[to] are the shared
/// filter bounds (inclusive); OPEN ON seeds the series with the true
/// balance at [from]. Pass [currency] to keep a single currency
/// unconverted, or [convertTo] for the market-value view (mutually
/// exclusive).
String balanceSeriesQuery({
  required List<String> accountNames,
  required Granularity granularity,
  DateTime? from,
  DateTime? to,
  String? currency,
  String? convertTo,
}) {
  final value = convertTo != null
      ? 'convert(last(balance), ${_quote(convertTo)}) AS bal'
      : 'last(balance) AS bal';
  final fromOptions = [
    if (from != null) 'OPEN ON ${_date(from)}',
    if (to != null) 'CLOSE ON ${_date(_dayAfter(to))}',
  ];
  final conditions = [
    'account ~ ${_quote(subtreePattern(accountNames))}',
    if (currency != null) 'currency = ${_quote(currency)}',
  ];
  return 'SELECT ${_bucketColumns(granularity)}, $value'
      '${fromOptions.isEmpty ? '' : ' FROM ${fromOptions.join(' ')}'}'
      ' WHERE ${conditions.join(' AND ')}'
      ' GROUP BY ${_bucketKeys(granularity)}';
}

/// Per-bucket flow totals over one or more account subtrees (bar chart).
/// Multiple [accountNames] net per bucket with raw ledger signs.
String periodTotalsQuery({
  required List<String> accountNames,
  required Granularity granularity,
  DateTime? from,
  DateTime? to,
  String? currency,
  String? convertTo,
}) {
  final value = convertTo != null
      ? 'convert(sum(position), ${_quote(convertTo)}) AS total'
      : 'sum(position) AS total';
  final conditions = [
    'account ~ ${_quote(subtreePattern(accountNames))}',
    if (currency != null) 'currency = ${_quote(currency)}',
    if (from != null) 'date >= ${_date(from)}',
    if (to != null) 'date < ${_date(_dayAfter(to))}',
  ];
  return 'SELECT ${_bucketColumns(granularity)}, $value'
      ' WHERE ${conditions.join(' AND ')}'
      ' GROUP BY ${_bucketKeys(granularity)}';
}
