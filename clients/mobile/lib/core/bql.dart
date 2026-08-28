import 'package:intl/intl.dart';

/// Builders for the BQL-subset queries sent to POST /ledger:query.
///
/// Keeping query construction here (pure string functions) makes the exact
/// wire format unit-testable. See docs/specs/reporting-query.md for the
/// language contract.

enum Granularity { daily, monthly, yearly }

/// How a series' amounts are basis-valued when [convertTo] is set: at
/// booking-time cost (`convert(x, currency)`, today's behavior) or at
/// current market price (`convert(value(x), currency)`). No effect when
/// [convertTo] is null — there's nothing to convert.
enum Valuation { cost, market }

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

/// `aggregate AS alias`, optionally converted to [convertTo] — at cost
/// (today's `convert(x, currency)`) or, for [Valuation.market], first
/// revalued at market price (`convert(value(x), currency)`). [at], when
/// given, prices both the revaluation and the FX leg as of that date
/// instead of each bucket's own end date — see openingBalanceQuery, the
/// only caller that needs this (its year-only grouping makes the bucket
/// end date the wrong price date for a point-in-time balance).
String _valuedAggregate(
  String aggregate,
  String alias, {
  required String? convertTo,
  required Valuation valuation,
  DateTime? at,
}) {
  if (convertTo == null) return '$aggregate AS $alias';
  final inner = valuation == Valuation.market ? 'value($aggregate)' : aggregate;
  final dateArg = at == null ? '' : ', ${_date(at)}';
  return 'convert($inner, ${_quote(convertTo)}$dateArg) AS $alias';
}

/// Running-balance series over one or more account subtrees (line chart).
///
/// Multiple [accountNames] net into a single series with raw ledger signs
/// (e.g. Assets + Liabilities = net worth). [from]/[to] are the shared
/// filter bounds (inclusive); OPEN ON seeds the series with the true
/// balance at [from]. Pass [currency] to keep a single currency
/// unconverted, or [convertTo] to convert it — at cost or at market price
/// per [valuation] (mutually exclusive with [currency]).
String balanceSeriesQuery({
  required List<String> accountNames,
  required Granularity granularity,
  DateTime? from,
  DateTime? to,
  String? currency,
  String? convertTo,
  Valuation valuation = Valuation.cost,
}) {
  final value = _valuedAggregate(
    'last(balance)',
    'bal',
    convertTo: convertTo,
    valuation: valuation,
  );
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

/// The true balance immediately before [from] — i.e. everything strictly
/// before the display range starts, with no lower bound of its own. Used
/// for the header's percent-delta chip instead of a balanceSeriesQuery's
/// first bucket, which is already the balance at that bucket's *end* (it
/// includes that bucket's own activity — see balanceSeriesQuery's OPEN ON
/// seeding) and is therefore granularity-dependent: with monthly buckets
/// "first" silently means "end of the first month", not the range's true
/// starting balance.
///
/// GROUP BY year rather than an OPEN ON-seeded single bucket: a bucket
/// with no postings at all produces no row (see reporting-query.md), so a
/// tightly-windowed single-bucket query would often come back empty even
/// though a real prior balance exists. Grouping by year instead returns
/// one row per year that had *any* activity before [from] — small and
/// bounded for any real ledger — and the caller (decodeLatestYearlyBalance
/// in chart_series.dart) takes the chronologically latest one, which is
/// exactly the running balance carried forward to [from].
///
/// [convertTo] passes [from] as an explicit conversion date rather than
/// letting it default to each row's own (yearly) bucket end: a "balance as
/// of [from]" reading has to be priced as of [from], not as of Dec 31 of
/// whichever year the latest activity happened to fall in.
String openingBalanceQuery({
  required List<String> accountNames,
  required DateTime from,
  String? currency,
  String? convertTo,
  Valuation valuation = Valuation.cost,
}) {
  final value = _valuedAggregate(
    'last(balance)',
    'bal',
    convertTo: convertTo,
    valuation: valuation,
    at: from,
  );
  final conditions = [
    'account ~ ${_quote(subtreePattern(accountNames))}',
    if (currency != null) 'currency = ${_quote(currency)}',
  ];
  return 'SELECT ${_bucketColumns(Granularity.yearly)}, $value'
      ' FROM CLOSE ON ${_date(from)}'
      ' WHERE ${conditions.join(' AND ')}'
      ' GROUP BY ${_bucketKeys(Granularity.yearly)}';
}

/// Per-bucket flow totals over one or more account subtrees (bar chart).
/// Multiple [accountNames] net per bucket with raw ledger signs. Always at
/// cost — a period's flow total has no meaningful "market value" reading,
/// so unlike [balanceSeriesQuery]/[openingBalanceQuery] there's no
/// [Valuation] to choose (the chart hides the Cost/Market chips for flow
/// specs; see AccountChartCard._buildValuationChips).
String periodTotalsQuery({
  required List<String> accountNames,
  required Granularity granularity,
  DateTime? from,
  DateTime? to,
  String? currency,
  String? convertTo,
}) {
  final value = _valuedAggregate(
    'sum(position)',
    'total',
    convertTo: convertTo,
    valuation: Valuation.cost,
  );
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
