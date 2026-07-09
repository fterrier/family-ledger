import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../core/account_category.dart';
import '../core/amount_format.dart';
import '../core/api_error.dart';
import '../core/bql.dart';
import '../core/chart_series.dart';
import '../models/account.dart';
import '../models/doctor_issue.dart';
import '../models/query_result.dart';
import '../repositories/query_repository.dart';

/// Balance/spending chart for the account selected in the global filter.
///
/// Balance-sheet accounts (Assets/Liabilities/Equity) render a running
/// balance line with raw ledger signs; Expenses/Income render per-bucket
/// magnitude bars. Bucket granularity follows the filter span. Tapping a
/// bucket narrows the shared filter to that bucket via [onBucketSelected].
class AccountChartCard extends StatefulWidget {
  final QueryRepository queryRepository;
  final AccountResource account;
  final DateTime? fromDate;
  final DateTime? toDate;
  final String? rangeLabel;
  final String defaultCurrency;
  final bool showsLastImportHint;
  final int refreshTick;
  final void Function(DateTime from, DateTime to)? onBucketSelected;

  /// Failed balance assertions for this account's subtree (from doctor);
  /// rendered as red bands on the chart plus a tappable badge.
  final List<DoctorIssue> assertionIssues;

  const AccountChartCard({
    super.key,
    required this.queryRepository,
    required this.account,
    this.fromDate,
    this.toDate,
    this.rangeLabel,
    this.defaultCurrency = 'CHF',
    this.showsLastImportHint = false,
    this.refreshTick = 0,
    this.onBucketSelected,
    this.assertionIssues = const [],
  });

  @override
  State<AccountChartCard> createState() => _AccountChartCardState();
}

class _AccountChartCardState extends State<AccountChartCard> {
  static const _issueRed = Color(0xFFFF3B30);
  static const _positiveGreen = Color(0xFF34C759);
  static const _textPrimary = Color(0xFF1C1C1E);
  static const _textSecondary = Color(0xFF8E8E93);

  bool _loading = true;
  ApiError? _error;
  AccountChartSeries? _series;
  ConvertedChartSeries? _converted;
  ApiError? _convertedError;
  List<QueryWarningInfo> _warnings = const [];

  /// Selected currency chip; null means the converted (≈) view.
  String? _selectedCurrency;
  int _generation = 0;

  bool get _isFlow {
    final category = categoryOf(widget.account.accountName);
    return category == AccountCategory.expense ||
        category == AccountCategory.income;
  }

  Granularity get _granularity =>
      granularityForSpan(widget.fromDate, widget.toDate);

  @override
  void initState() {
    super.initState();
    _loadBase();
  }

  @override
  void didUpdateWidget(AccountChartCard old) {
    super.didUpdateWidget(old);
    if (old.account.name != widget.account.name ||
        old.fromDate != widget.fromDate ||
        old.toDate != widget.toDate ||
        old.refreshTick != widget.refreshTick) {
      _loadBase();
    } else if (old.defaultCurrency != widget.defaultCurrency &&
        (_series?.currencies.length ?? 0) > 1) {
      // Only the conversion target changed — no need to re-fetch the
      // per-currency series, just the converted (≈) one.
      setState(() {
        _converted = null;
        _convertedError = null;
      });
      _loadConverted(_generation);
    }
  }

  Future<void> _loadBase() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
      _converted = null;
      _convertedError = null;
      _warnings = const [];
    });
    final granularity = _granularity;
    final query = _isFlow
        ? periodTotalsQuery(
            accountName: widget.account.accountName,
            granularity: granularity,
            from: widget.fromDate,
            to: widget.toDate,
          )
        : balanceSeriesQuery(
            accountName: widget.account.accountName,
            granularity: granularity,
            from: widget.fromDate,
            to: widget.toDate,
          );
    final result = await widget.queryRepository.run(query);
    if (!mounted || generation != _generation) return;
    if (result.error != null) {
      setState(() {
        _loading = false;
        _error = result.error;
      });
      return;
    }
    final series = _isFlow
        ? buildTotalsSeries(result.data!, granularity)
        : buildBalanceSeries(result.data!, granularity);
    setState(() {
      _series = series;
      _selectedCurrency = series.currencies.length == 1
          ? series.currencies.single
          : null; // multi-currency defaults to the converted view
      _loading = false;
    });
    if (series.currencies.length > 1) {
      await _loadConverted(generation);
    }
  }

  Future<void> _loadConverted(int generation) async {
    final granularity = _granularity;
    final query = _isFlow
        ? periodTotalsQuery(
            accountName: widget.account.accountName,
            granularity: granularity,
            from: widget.fromDate,
            to: widget.toDate,
            convertTo: widget.defaultCurrency,
          )
        : balanceSeriesQuery(
            accountName: widget.account.accountName,
            granularity: granularity,
            from: widget.fromDate,
            to: widget.toDate,
            convertTo: widget.defaultCurrency,
          );
    final result = await widget.queryRepository.run(query);
    if (!mounted || generation != _generation) return;
    if (result.error != null) {
      // Keep this scoped to the converted view: the base series (and any
      // single-currency chip) already loaded successfully and must stay
      // usable rather than being hidden behind a full-card error.
      setState(() => _convertedError = result.error);
      return;
    }
    setState(() {
      _converted = buildConvertedSeries(
        result.data!,
        granularity,
        currency: widget.defaultCurrency,
        cumulative: !_isFlow,
      );
      _convertedError = null;
      _warnings = result.data!.warnings;
    });
  }

  Future<void> _retryConverted() => _loadConverted(_generation);

  // -- projections -----------------------------------------------------------

  bool get _showingConverted =>
      _selectedCurrency == null && (_series?.currencies.length ?? 0) > 1;

  List<ChartBucket> get _buckets =>
      _showingConverted ? _converted?.buckets ?? const [] : _series!.buckets;

  List<double?> get _values => _showingConverted
      ? _converted?.values ?? const []
      : _series!.valuesByCurrency[_selectedCurrency] ?? const [];

  // Reads the currency actually baked into the loaded converted series
  // (falling back to the live default while that series is in flight),
  // rather than the widget's current defaultCurrency — the two can
  // momentarily disagree if the default currency changes while a
  // previously-fetched converted series is still displayed.
  String get _displayCurrency => _showingConverted
      ? _converted?.currency ?? widget.defaultCurrency
      : _selectedCurrency ?? '';

  double? get _lastValue =>
      _values.lastWhere((v) => v != null, orElse: () => null);

  double? get _firstValue =>
      _values.firstWhere((v) => v != null, orElse: () => null);

  // -- interactions ----------------------------------------------------------

  void _onBucketTap(int index) {
    final buckets = _buckets;
    if (index < 0 || index >= buckets.length) return;
    final bucket = buckets[index];
    widget.onBucketSelected?.call(bucket.start, bucket.end);
  }

  /// Bucket indices containing a failed balance assertion.
  List<int> get _assertionBandIndices {
    final buckets = _buckets;
    final indices = <int>{};
    for (final issue in widget.assertionIssues) {
      final date = issue.date;
      if (date == null) continue;
      for (var i = 0; i < buckets.length; i++) {
        if (!date.isBefore(buckets[i].start) && !date.isAfter(buckets[i].end)) {
          indices.add(i);
          break;
        }
      }
    }
    return indices.toList()..sort();
  }

  void _showAssertionFailures() {
    final dateFormat = DateFormat('MMM d, yyyy');
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              'Balance assertion failures',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
            for (final issue in widget.assertionIssues)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      issue.date != null
                          ? dateFormat.format(issue.date!)
                          : (issue.targetSummary['date'] ?? ''),
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: _textPrimary,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'expected ${issue.details['asserted_amount'] ?? '?'}, '
                      'actual ${issue.details['actual_amount'] ?? '?'} '
                      '(Δ ${issue.details['diff'] ?? '?'} '
                      '${issue.details['symbol'] ?? ''})',
                      style: const TextStyle(fontSize: 13, color: _issueRed),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _showWarnings() {
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              'Price warnings',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
            for (final warning in _warnings)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Text(
                  warning.message,
                  style: const TextStyle(fontSize: 14, color: _textPrimary),
                ),
              ),
          ],
        ),
      ),
    );
  }

  // -- labels ----------------------------------------------------------------

  DateFormat get _bucketFormat => switch (_granularity) {
    Granularity.daily => DateFormat('d MMM'),
    Granularity.monthly => DateFormat('MMM yy'),
    Granularity.yearly => DateFormat('yyyy'),
  };

  String _formatValue(double v) => '${formatFixedAmount(v)} $_displayCurrency';

  // -- build -----------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
      ),
      child: _buildContent(),
    );
  }

  Widget _buildContent() {
    if (_loading) {
      return const SizedBox(
        height: 220,
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    if (_error != null) {
      return SizedBox(
        height: 120,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                _error!.displayMessage,
                style: const TextStyle(fontSize: 13, color: _textSecondary),
                textAlign: TextAlign.center,
              ),
              TextButton(onPressed: _loadBase, child: const Text('Retry')),
            ],
          ),
        ),
      );
    }
    final series = _series;
    if (series == null || series.isEmpty) {
      return SizedBox(
        height: 120,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildHeader(),
            const Expanded(
              child: Center(
                child: Text(
                  'No data in range',
                  style: TextStyle(fontSize: 13, color: _textSecondary),
                ),
              ),
            ),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _buildHeader(),
        const SizedBox(height: 4),
        _buildHeadline(),
        const SizedBox(height: 12),
        // The converted projection is empty until its query returns; fl_chart
        // crashes on empty data (maxX would be -1), so show a placeholder.
        // A converted-query failure is scoped to this slot only — the
        // header/headline/chips above stay driven by the valid base series.
        SizedBox(
          height: 180,
          child: _showingConverted && _convertedError != null
              ? _buildConvertedError()
              : _values.isEmpty
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : _isFlow
              ? _buildBars()
              : _buildLine(),
        ),
        if (series.currencies.length > 1) ...[
          const SizedBox(height: 8),
          _buildCurrencyChips(),
        ],
        if (widget.showsLastImportHint)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              "Chart ignores the 'last import' filter",
              style: TextStyle(fontSize: 12, color: _textSecondary),
            ),
          ),
      ],
    );
  }

  Widget _buildHeader() {
    final theme = themeForAccount(widget.account.accountName);
    return Row(
      children: [
        Container(
          width: 18,
          height: 18,
          decoration: BoxDecoration(color: theme.color, shape: BoxShape.circle),
          child: Icon(theme.icon, size: 10, color: Colors.white),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            widget.account.displayName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: _textPrimary,
            ),
          ),
        ),
        if (widget.assertionIssues.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: GestureDetector(
              onTap: _showAssertionFailures,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0xFFFFEBEE),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline, size: 14, color: _issueRed),
                    const SizedBox(width: 4),
                    Text(
                      '${widget.assertionIssues.length}',
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: _issueRed,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        if (_warnings.isNotEmpty && _showingConverted)
          GestureDetector(
            onTap: _showWarnings,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: const Color(0xFFFFF3E0),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(
                    Icons.warning_amber_rounded,
                    size: 14,
                    color: Color(0xFFFF9500),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    '${_warnings.length}',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFFFF9500),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildHeadline() {
    final last = _lastValue;
    if (last == null) {
      return Text(
        widget.rangeLabel ?? 'All history',
        style: const TextStyle(fontSize: 12, color: _textSecondary),
      );
    }
    final headline = _isFlow
        ? _formatValue(_values.fold<double>(0, (sum, v) => sum + (v ?? 0)))
        : _formatValue(last);

    Widget? deltaChip;
    final first = _firstValue;
    if (!_isFlow && first != null && _values.length > 1) {
      final delta = last - first;
      final positive = delta >= 0;
      final percent = first != 0
          ? ' · ${positive ? '+' : ''}${(delta / first.abs() * 100).toStringAsFixed(1)}%'
          : '';
      deltaChip = Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: positive ? const Color(0xFFE8F5E9) : const Color(0xFFFFEBEE),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(
          '${positive ? '+' : ''}${formatFixedAmount(delta)}$percent',
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: positive ? _positiveGreen : _issueRed,
          ),
        ),
      );
    }

    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Flexible(
          child: Text(
            headline,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w600,
              color: _textPrimary,
            ),
          ),
        ),
        if (deltaChip != null) ...[const SizedBox(width: 8), deltaChip],
        const Spacer(),
        Text(
          widget.rangeLabel ?? 'All history',
          style: const TextStyle(fontSize: 12, color: _textSecondary),
        ),
      ],
    );
  }

  Widget _buildCurrencyChips() {
    final series = _series!;
    final chips = <Widget>[
      for (final currency in series.currencies)
        _chip(
          currency,
          selected: _selectedCurrency == currency,
          onTap: () {
            setState(() => _selectedCurrency = currency);
          },
        ),
      _chip(
        '≈ ${widget.defaultCurrency}',
        selected: _showingConverted,
        onTap: () => setState(() => _selectedCurrency = null),
      ),
    ];
    return Wrap(spacing: 6, children: chips);
  }

  Widget _chip(
    String label, {
    required bool selected,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: selected ? const Color(0xFF1A73E8) : const Color(0xFFF2F2F7),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: selected ? Colors.white : _textSecondary,
          ),
        ),
      ),
    );
  }

  Widget _bottomTitle(double value, TitleMeta meta) {
    final index = value.round();
    final buckets = _buckets;
    if (index < 0 || index >= buckets.length || value != index.toDouble()) {
      return const SizedBox.shrink();
    }
    return SideTitleWidget(
      meta: meta,
      child: Text(
        _bucketFormat.format(buckets[index].start),
        style: const TextStyle(fontSize: 10, color: _textSecondary),
      ),
    );
  }

  double get _labelInterval {
    final n = _buckets.length;
    return n <= 5 ? 1 : (n / 4).ceilToDouble();
  }

  Widget _buildLine() {
    final theme = themeForAccount(widget.account.accountName);
    final values = _values;

    // Nulls (price gaps / currency not yet present) split the line into
    // separate segments so gaps stay visible.
    final segments = <List<FlSpot>>[];
    var current = <FlSpot>[];
    for (var i = 0; i < values.length; i++) {
      final v = values[i];
      if (v == null) {
        if (current.isNotEmpty) segments.add(current);
        current = [];
      } else {
        current.add(FlSpot(i.toDouble(), v));
      }
    }
    if (current.isNotEmpty) segments.add(current);

    // Explicit Y bounds with padding: a flat line (min == max) would give
    // fl_chart a zero grid interval, another crash at render time. All-null
    // values (nothing drawable) also need a synthetic range.
    final drawable = [for (final v in values) ?v];
    var minY = drawable.isEmpty
        ? 0.0
        : drawable.reduce((a, b) => a < b ? a : b);
    var maxY = drawable.isEmpty
        ? 1.0
        : drawable.reduce((a, b) => a > b ? a : b);
    final padding = (maxY - minY) == 0
        ? (maxY.abs() * 0.1 + 1)
        : (maxY - minY) * 0.08;
    minY -= padding;
    maxY += padding;

    return LineChart(
      LineChartData(
        minY: minY,
        maxY: maxY,
        lineBarsData: [
          for (final segment in segments)
            LineChartBarData(
              spots: segment,
              color: theme.color,
              dotData: FlDotData(show: segment.length == 1),
              belowBarData: BarAreaData(
                show: true,
                color: theme.color.withValues(alpha: 0.08),
              ),
            ),
        ],
        rangeAnnotations: RangeAnnotations(
          verticalRangeAnnotations: [
            for (final index in _assertionBandIndices)
              VerticalRangeAnnotation(
                x1: (index - 0.5).clamp(0, (values.length - 1).toDouble()),
                x2: (index + 0.5).clamp(0, (values.length - 1).toDouble()),
                color: _issueRed.withValues(alpha: 0.12),
              ),
          ],
        ),
        minX: 0,
        maxX: (values.length - 1).toDouble(),
        gridData: const FlGridData(drawVerticalLine: false),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(),
          rightTitles: const AxisTitles(),
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 52,
              getTitlesWidget: (value, meta) => Text(
                NumberFormat.compact().format(value),
                style: const TextStyle(fontSize: 10, color: _textSecondary),
              ),
            ),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              interval: _labelInterval,
              getTitlesWidget: _bottomTitle,
              reservedSize: 24,
            ),
          ),
        ),
        lineTouchData: LineTouchData(
          touchTooltipData: LineTouchTooltipData(
            getTooltipItems: (spots) => [
              for (final spot in spots)
                LineTooltipItem(
                  '${_bucketFormat.format(_buckets[spot.x.toInt()].start)}\n'
                  '${_formatValue(spot.y)}',
                  const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
            ],
          ),
          touchCallback: (event, response) {
            if (event is FlTapUpEvent &&
                response?.lineBarSpots?.isNotEmpty == true) {
              _onBucketTap(response!.lineBarSpots!.first.x.toInt());
            }
          },
        ),
      ),
    );
  }

  Widget _buildBars() {
    final theme = themeForAccount(widget.account.accountName);
    final values = _values;

    // All-zero bars would give fl_chart a zero Y range; force a minimal one.
    var maxY = 0.0;
    for (final v in values) {
      if (v != null && v > maxY) maxY = v;
    }
    maxY = maxY == 0 ? 1 : maxY * 1.1;

    return BarChart(
      BarChartData(
        maxY: maxY,
        barGroups: [
          for (var i = 0; i < values.length; i++)
            BarChartGroupData(
              x: i,
              barRods: [
                BarChartRodData(
                  toY: values[i] ?? 0,
                  color: theme.color,
                  width: 8,
                  borderRadius: BorderRadius.circular(2),
                ),
              ],
            ),
        ],
        gridData: const FlGridData(drawVerticalLine: false),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(),
          rightTitles: const AxisTitles(),
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 52,
              getTitlesWidget: (value, meta) => Text(
                NumberFormat.compact().format(value),
                style: const TextStyle(fontSize: 10, color: _textSecondary),
              ),
            ),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              interval: _labelInterval,
              getTitlesWidget: _bottomTitle,
              reservedSize: 24,
            ),
          ),
        ),
        barTouchData: BarTouchData(
          touchTooltipData: BarTouchTooltipData(
            getTooltipItem: (group, groupIndex, rod, rodIndex) =>
                BarTooltipItem(
                  '${_bucketFormat.format(_buckets[group.x].start)}\n'
                  '${_formatValue(rod.toY)}',
                  const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
          ),
          touchCallback: (event, response) {
            if (event is FlTapUpEvent && response?.spot != null) {
              _onBucketTap(response!.spot!.touchedBarGroupIndex);
            }
          },
        ),
      ),
    );
  }

  Widget _buildConvertedError() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            _convertedError!.displayMessage,
            style: const TextStyle(fontSize: 13, color: _textSecondary),
            textAlign: TextAlign.center,
          ),
          TextButton(onPressed: _retryConverted, child: const Text('Retry')),
        ],
      ),
    );
  }
}
