import 'dart:ui' as ui;

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

  /// Commodity the shared transaction filter narrowed to, if any — scopes
  /// the chart's query exactly like it scopes the transaction list.
  final String? currencyFilter;
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
    this.currencyFilter,
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
  static const _issueRedBg = Color(0xFFFFEBEE);
  static const _positiveGreen = Color(0xFF34C759);
  static const _positiveGreenBg = Color(0xFFE8F5E9);
  static const _warningOrange = Color(0xFFFF9500);
  static const _warningOrangeBg = Color(0xFFFFF3E0);
  static const _textPrimary = Color(0xFF1C1C1E);
  static const _textSecondary = Color(0xFF8E8E93);

  static const _tooltipTextStyle = TextStyle(
    fontSize: 11,
    fontWeight: FontWeight.w600,
    color: Colors.white,
  );
  static const _gridData = FlGridData(drawVerticalLine: false);
  static final _borderData = FlBorderData(show: false);

  // Constructed once and reused: fl_chart re-invokes axis-title and tooltip
  // callbacks on every touch/drag frame, so building a formatter fresh
  // inside them allocates dozens of times per second during interaction.
  static final _compactFormat = NumberFormat.compact();
  static final _assertionDateFormat = DateFormat('MMM d, yyyy');
  static final _dailyBucketFormat = DateFormat('d MMM');
  static final _monthlyBucketFormat = DateFormat('MMM yy');
  static final _yearlyBucketFormat = DateFormat('yyyy');

  bool _loading = true;
  ApiError? _error;
  AccountChartSeries? _series;
  ConvertedChartSeries? _converted;
  ApiError? _convertedError;
  List<QueryWarningInfo> _warnings = const [];

  int _generation = 0;

  /// Bucket granularity. Defaults to the span-derived heuristic
  /// ([granularityForSpan]) and resets to it whenever the account or date
  /// range changes — including a bucket-tap narrowing, which is itself a
  /// date-range change. A user's chip pick otherwise sticks for that view:
  /// it survives a commodity-filter change or an unrelated data refresh
  /// (e.g. editing a transaction elsewhere in the list), both of which
  /// still reload the chart's data but aren't a new view.
  late Granularity _granularity;

  // Memoized against the exact bucket list currently on screen so a resize
  // (which re-invokes the LayoutBuilder below) doesn't re-measure text on
  // every frame.
  List<ChartBucket>? _labelWidthCacheKey;
  double _labelWidthCache = 0;

  bool get _isFlow {
    final category = categoryOf(widget.account.accountName);
    return category == AccountCategory.expense ||
        category == AccountCategory.income;
  }

  @override
  void initState() {
    super.initState();
    _granularity = granularityForSpan(widget.fromDate, widget.toDate);
    _loadBase();
  }

  @override
  void didUpdateWidget(AccountChartCard old) {
    super.didUpdateWidget(old);
    // A new account or date range (including a bucket-tap narrowing) is a
    // new view: reset the granularity pick back to the span-derived
    // default. refreshTick, by contrast, fires on plenty of unrelated
    // events (editing/deleting/merging a transaction elsewhere in the
    // list) — it must still trigger a reload (the data may have changed)
    // but must NOT reset a granularity the user already picked for this
    // same view. Keeping this as its own boolean (rather than folding it
    // into the reload condition below) is what makes that distinction
    // actually take effect, rather than reload and reset always agreeing
    // just because both conditions happened to overlap.
    final isNewView =
        old.account.name != widget.account.name ||
        old.fromDate != widget.fromDate ||
        old.toDate != widget.toDate;
    final needsReload =
        isNewView ||
        old.refreshTick != widget.refreshTick ||
        old.currencyFilter != widget.currencyFilter;
    if (needsReload) {
      if (isNewView) {
        _granularity = granularityForSpan(widget.fromDate, widget.toDate);
      }
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

  String _seriesQuery(Granularity granularity, {String? convertTo}) {
    return _isFlow
        ? periodTotalsQuery(
            accountName: widget.account.accountName,
            granularity: granularity,
            from: widget.fromDate,
            to: widget.toDate,
            currency: widget.currencyFilter,
            convertTo: convertTo,
          )
        : balanceSeriesQuery(
            accountName: widget.account.accountName,
            granularity: granularity,
            from: widget.fromDate,
            to: widget.toDate,
            currency: widget.currencyFilter,
            convertTo: convertTo,
          );
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
    final result = await widget.queryRepository.run(_seriesQuery(granularity));
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
      _loading = false;
    });
    if (series.currencies.length > 1) {
      await _loadConverted(generation);
    }
  }

  Future<void> _loadConverted(int generation) async {
    final granularity = _granularity;
    final query = _seriesQuery(granularity, convertTo: widget.defaultCurrency);
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

  // Multi-currency series have no single "unit" to fall back to, so they
  // always show the combined converted view; single- and zero-currency
  // series show the raw series as-is.
  bool get _showingConverted => (_series?.currencies.length ?? 0) > 1;

  List<ChartBucket> get _buckets =>
      _showingConverted ? _converted?.buckets ?? const [] : _series!.buckets;

  List<double?> get _values {
    if (_showingConverted) return _converted?.values ?? const [];
    final currencies = _series!.currencies;
    if (currencies.length != 1) return const [];
    return _series!.valuesByCurrency[currencies.single] ?? const [];
  }

  // Reads the currency actually baked into the loaded converted series
  // (falling back to the live default while that series is in flight),
  // rather than the widget's current defaultCurrency — the two can
  // momentarily disagree if the default currency changes while a
  // previously-fetched converted series is still displayed.
  String get _displayCurrency {
    if (_showingConverted) {
      return _converted?.currency ?? widget.defaultCurrency;
    }
    final currencies = _series?.currencies ?? const [];
    return currencies.length == 1 ? currencies.single : '';
  }

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
                          ? _assertionDateFormat.format(issue.date!)
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
    Granularity.daily => _dailyBucketFormat,
    Granularity.monthly => _monthlyBucketFormat,
    Granularity.yearly => _yearlyBucketFormat,
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
      return SizedBox(height: 120, child: _errorView(_error!, _loadBase));
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
              ? _errorView(_convertedError!, _retryConverted)
              : _values.isEmpty
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : LayoutBuilder(
                  builder: (context, constraints) {
                    final interval = _labelInterval(constraints.maxWidth);
                    return _isFlow
                        ? _buildBars(interval, _barWidth(constraints.maxWidth))
                        : _buildLine(interval);
                  },
                ),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(child: _buildGranularityChips()),
            if (_hasIssuePills) _buildIssuePills(),
          ],
        ),
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

  Widget _errorView(ApiError error, VoidCallback onRetry) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            error.displayMessage,
            style: const TextStyle(fontSize: 13, color: _textSecondary),
            textAlign: TextAlign.center,
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
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
        Text(
          widget.rangeLabel ?? 'All history',
          style: const TextStyle(fontSize: 12, color: _textSecondary),
        ),
      ],
    );
  }

  bool get _hasIssuePills =>
      widget.assertionIssues.isNotEmpty ||
      (_warnings.isNotEmpty && _showingConverted);

  /// Assertion/warning pills, right-aligned in the granularity-chip row
  /// below the chart rather than competing for space in the header row.
  Widget _buildIssuePills() {
    return Wrap(
      spacing: 6,
      children: [
        if (widget.assertionIssues.isNotEmpty)
          _badge(
            icon: Icons.error_outline,
            label: '${widget.assertionIssues.length}',
            background: _issueRedBg,
            foreground: _issueRed,
            onTap: _showAssertionFailures,
          ),
        if (_warnings.isNotEmpty && _showingConverted)
          _badge(
            icon: Icons.warning_amber_rounded,
            label: '${_warnings.length}',
            background: _warningOrangeBg,
            foreground: _warningOrange,
            onTap: _showWarnings,
          ),
      ],
    );
  }

  Widget _buildHeadline() {
    final last = _lastValue;
    if (last == null) return const SizedBox.shrink();
    final headline = _isFlow
        ? _formatValue(_values.fold<double>(0, (sum, v) => sum + (v ?? 0)))
        : _formatValue(last);

    // Percentage change only — the absolute delta is redundant with the
    // headline balance right next to it, and previously made this chip long
    // enough to overflow the header row at narrow widths.
    Widget? deltaChip;
    final first = _firstValue;
    if (!_isFlow && first != null && first != 0 && _values.length > 1) {
      final delta = last - first;
      final positive = delta >= 0;
      final percent = (delta / first.abs() * 100).toStringAsFixed(1);
      deltaChip = _badge(
        label: '${positive ? '+' : ''}$percent%',
        background: positive ? _positiveGreenBg : _issueRedBg,
        foreground: positive ? _positiveGreen : _issueRed,
      );
    }

    // Wrap (not Row) so the amount is never ellipsis-truncated: if the pair
    // doesn't fit on one line, the chip wraps below instead of clipping the
    // balance text.
    return Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 8,
      children: [
        Text(
          headline,
          style: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w600,
            color: _textPrimary,
          ),
        ),
        ?deltaChip,
      ],
    );
  }

  /// Small colored pill shared by the assertion badge, warnings badge, and
  /// delta chip: an optional leading icon plus a label, tappable when
  /// [onTap] is given. The currency-selector chips (below) have a
  /// different shape (selection-state coloring, always tappable) and stay
  /// on their own [_chip] helper.
  Widget _badge({
    IconData? icon,
    required String label,
    required Color background,
    required Color foreground,
    VoidCallback? onTap,
  }) {
    final content = Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: foreground),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: foreground,
            ),
          ),
        ],
      ),
    );
    return onTap == null
        ? content
        : GestureDetector(onTap: onTap, child: content);
  }

  static const _granularityLabels = {
    Granularity.daily: 'Day',
    Granularity.monthly: 'Month',
    Granularity.yearly: 'Year',
  };

  Widget _buildGranularityChips() {
    return Wrap(
      spacing: 6,
      children: [
        for (final granularity in Granularity.values)
          _chip(
            _granularityLabels[granularity]!,
            selected: _granularity == granularity,
            onTap: () {
              if (_granularity == granularity) return;
              setState(() => _granularity = granularity);
              _loadBase();
            },
          ),
      ],
    );
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

  // fl_chart's bar charts generate one axis tick per bar group directly
  // (bypassing SideTitles.interval entirely, unlike line charts), so the
  // thinning has to be enforced here rather than relying on `interval`
  // alone — this filter applies regardless of which chart type invoked it.
  Widget _bottomTitle(double value, TitleMeta meta, double labelInterval) {
    final index = value.round();
    final buckets = _buckets;
    final step = labelInterval.round().clamp(1, 1 << 30);
    if (index < 0 ||
        index >= buckets.length ||
        value != index.toDouble() ||
        index % step != 0) {
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

  /// Widest rendered width of the current buckets' axis labels, in the same
  /// text style [_bottomTitle] draws with. Measured once per bucket list
  /// (not per frame/rebuild) via the cache above.
  double _maxLabelWidth() {
    final buckets = _buckets;
    if (identical(buckets, _labelWidthCacheKey)) return _labelWidthCache;
    final format = _bucketFormat;
    var maxWidth = 0.0;
    for (final bucket in buckets) {
      final painter = TextPainter(
        text: TextSpan(
          text: format.format(bucket.start),
          style: const TextStyle(fontSize: 10),
        ),
        textDirection: ui.TextDirection.ltr,
      )..layout();
      if (painter.width > maxWidth) maxWidth = painter.width;
    }
    _labelWidthCache = maxWidth;
    _labelWidthCacheKey = buckets;
    return maxWidth;
  }

  // Reserved width of the left (y-axis) titles — must match _titlesData's
  // leftTitles.reservedSize below, since both _labelInterval and _barWidth
  // need the same "how much plot width is actually left" answer it does.
  static const _leftAxisWidth = 52.0;

  /// Remaining horizontal space for plotted content once the left axis's
  /// reserved width is subtracted, or null if there's no room (empty state
  /// callers should fall back to a fixed default rather than divide by ~0).
  double? _plotWidth(double availableWidth) {
    if (_buckets.isEmpty) return null;
    final plotWidth = availableWidth - _leftAxisWidth;
    return plotWidth > 0 ? plotWidth : null;
  }

  /// Bottom-axis label spacing so labels don't overlap: how many buckets'
  /// worth of [availableWidth] (chart width minus the left axis's reserved
  /// space) the widest label actually needs, rounded up to whole buckets.
  double _labelInterval(double availableWidth) {
    final plotWidth = _plotWidth(availableWidth);
    if (plotWidth == null) return 1;
    final raw = _maxLabelWidth() * _buckets.length / plotWidth;
    return raw <= 1 ? 1 : raw.ceilToDouble();
  }

  /// Bar width sized to the available plot space and bucket count: fl_chart
  /// spaces groups evenly across the full width regardless of rod width
  /// (`BarChartAlignment.spaceEvenly`, the default) and never shrinks rods to
  /// fit, so a fixed width either collides at high bucket counts (daily over
  /// a long range) or looks like a sliver against wide gaps at low bucket
  /// counts (yearly). Each bar gets ~60% of its group's fair share of the
  /// plot (`plotWidth / bucketCount`), capped at a size that stays visible
  /// without ballooning into a solid block for very few buckets. There is
  /// deliberately no lower-bound floor: with enough buckets, a floor above
  /// the fair share would push the *total* bar width past the plot width,
  /// reintroducing the exact collision this sizing exists to prevent —
  /// tight-but-thin bars are the correct outcome, not a floor-enforced
  /// overlap.
  double _barWidth(double availableWidth) {
    final plotWidth = _plotWidth(availableWidth);
    if (plotWidth == null) return 8;
    final fairShare = plotWidth / _buckets.length;
    final ideal = fairShare * 0.6;
    return ideal > 24.0 ? 24.0 : ideal;
  }

  /// Axis config shared by the line and bar charts — identical labeling,
  /// only the plotted data differs.
  FlTitlesData _titlesData(double labelInterval) => FlTitlesData(
    topTitles: const AxisTitles(),
    rightTitles: const AxisTitles(),
    leftTitles: AxisTitles(
      sideTitles: SideTitles(
        showTitles: true,
        reservedSize: _leftAxisWidth,
        getTitlesWidget: (value, meta) => Text(
          _compactFormat.format(value),
          style: const TextStyle(fontSize: 10, color: _textSecondary),
        ),
      ),
    ),
    bottomTitles: AxisTitles(
      sideTitles: SideTitles(
        showTitles: true,
        interval: labelInterval,
        getTitlesWidget: (value, meta) =>
            _bottomTitle(value, meta, labelInterval),
        reservedSize: 24,
      ),
    ),
  );

  Widget _buildLine(double labelInterval) {
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
        gridData: _gridData,
        borderData: _borderData,
        titlesData: _titlesData(labelInterval),
        lineTouchData: LineTouchData(
          touchTooltipData: LineTouchTooltipData(
            getTooltipItems: (spots) => [
              for (final spot in spots)
                LineTooltipItem(
                  '${_bucketFormat.format(_buckets[spot.x.toInt()].start)}\n'
                  '${_formatValue(spot.y)}',
                  _tooltipTextStyle,
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

  Widget _buildBars(double labelInterval, double barWidth) {
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
                  width: barWidth,
                  borderRadius: BorderRadius.circular(2),
                ),
              ],
            ),
        ],
        gridData: _gridData,
        borderData: _borderData,
        titlesData: _titlesData(labelInterval),
        barTouchData: BarTouchData(
          touchTooltipData: BarTouchTooltipData(
            getTooltipItem: (group, groupIndex, rod, rodIndex) =>
                BarTooltipItem(
                  '${_bucketFormat.format(_buckets[group.x].start)}\n'
                  '${_formatValue(rod.toY)}',
                  _tooltipTextStyle,
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
}
