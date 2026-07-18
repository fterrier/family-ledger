import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/account_category.dart';
import '../../core/account_hierarchy.dart';
import '../../core/amount_format.dart';
import '../../core/app_preferences.dart';
import '../../models/account.dart';
import '../../core/api_error.dart';
import '../../core/filter_persistence.dart';
import '../../core/generation_guard.dart';
import '../../core/home_view.dart';
import '../../core/posting_sum.dart';
import '../../models/doctor_issue.dart';
import '../../models/transaction.dart';
import '../../repositories/account_repository.dart';
import '../../repositories/commodity_repository.dart';
import '../../repositories/query_repository.dart';
import '../../repositories/transaction_repository.dart';
import '../../widgets/account_category_dot.dart';
import '../../widgets/account_chart_card.dart';
import '../../widgets/error_banner.dart';
import '../../widgets/issue_bar.dart';
import '../add_transaction/account_picker_screen.dart';
import '../transaction_edit/transaction_edit_screen.dart';
import 'date_filter_sheet.dart';
import 'more_filters_sheet.dart';
import 'transaction_filter.dart';

class TransactionListScreen extends StatefulWidget {
  final TransactionRepository transactionRepository;
  final AccountRepository accountRepository;
  final CommodityRepository commodityRepository;
  final QueryRepository queryRepository;
  final ValueNotifier<TransactionFilter>? filterNotifier;
  final ValueNotifier<Set<String>>? selectionNotifier;

  const TransactionListScreen({
    super.key,
    required this.transactionRepository,
    required this.accountRepository,
    required this.commodityRepository,
    required this.queryRepository,
    this.filterNotifier,
    this.selectionNotifier,
  });

  @override
  TransactionListScreenState createState() => TransactionListScreenState();
}

// The list fetch and the chart's query (via AccountChartCard.onError,
// which has no error UI of its own) are two independent, concurrently
// running network calls. Tracking them under one shared ApiError? field
// let whichever finished last — even a success — silently clear the
// other's still-active failure. Keying by source instead means each one
// only ever touches its own slot.
enum _ErrorSource { list, chart }

class TransactionListScreenState extends State<TransactionListScreen> {
  final _scrollController = ScrollController();

  List<TransactionResource> _transactions = [];
  String? _nextPageToken;
  bool _isLoading = false;

  final Map<_ErrorSource, ApiError> _errors = {};

  // The banner shows one message at a time; the list's own failure is the
  // more actionable one when both are active.
  ApiError? get _error =>
      _errors[_ErrorSource.list] ?? _errors[_ErrorSource.chart];

  bool _paginationError = false;

  // Started on each new fetch; _doFetch discards results from older generations.
  final _loadGuard = GenerationGuard();

  Set<String> _transactionsWithIssues = {};
  List<DoctorIssue> _assertionIssues = const [];
  final _doctorGuard = GenerationGuard();

  TransactionFilter _filter = const TransactionFilter();
  List<AccountResource> _accounts = const [];
  bool _filterSheetOpen = false;

  String? _defaultCurrency;
  int _chartRefreshTick = 0;

  Set<String> _selectedNames = {};
  bool _bulkActionBusy = false;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    _restorePrefsAndLoad();
    _prefetchAccounts();
  }

  // Explicitly sequenced: the default currency must be known before the
  // first fetch so it can ask for converted amounts (and so the chart's
  // first mount already has its conversion target).
  Future<void> _restorePrefsAndLoad() async {
    await _loadDefaultCurrency();
    final saved = await FilterPersistence.load();
    if (!mounted) return;
    _filter = saved;
    widget.filterNotifier?.value = _filter;
    _load();
  }

  Future<void> _loadDefaultCurrency() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    final stored = prefs.getString(AppPreferences.keyDefaultCurrency);
    if (stored != null && stored.isNotEmpty) {
      setState(() => _defaultCurrency = stored);
    }
  }

  // Called by the app shell after returning from App Settings — this
  // State survives that navigation (it isn't disposed), so a currency
  // change there would otherwise keep every fetch and row converting to
  // the old value until the app restarts.
  Future<void> reloadDefaultCurrencyAndRefresh() async {
    await _loadDefaultCurrency();
    if (mounted) refresh();
  }

  Future<void> _prefetchAccounts() async {
    final result = await widget.accountRepository.getAllAccounts();
    if (!mounted) return;
    _accounts = result.data ?? [];
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  // ScrollController.addListener fires synchronously during scroll activity,
  // so setState is safe to call directly here — no microtask needed.
  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final pos = _scrollController.position;
    if (pos.extentAfter < 800 &&
        _nextPageToken != null &&
        !_paginationError &&
        !_isLoading) {
      _load(pageToken: _nextPageToken);
    }
  }

  // Doctor is authoritative and already re-runs on every load/refresh/edit,
  // so the fresh result always wins outright — no "did anything actually
  // change" comparison to get subtly wrong (a stale-detail bug lived here
  // before: a same-count assertion whose amounts changed wasn't detected).
  void _refreshDoctorIssues() {
    final gen = _doctorGuard.start();
    widget.transactionRepository.runDoctorIssues().then((result) {
      if (!mounted || !_doctorGuard.isCurrent(gen)) return;
      final issues = result.data;
      if (issues == null) return;
      setState(() {
        _transactionsWithIssues = {
          for (final issue in issues)
            if (issue.target != null) issue.target!,
        };
        _assertionIssues = [
          for (final issue in issues)
            if (issue.code == DoctorIssue.balanceAssertionFailed) issue,
        ];
      });
    });
  }

  /// Account names (subtree roots) with failed balance assertions — feeds
  /// the account picker's red indicators.
  Set<String> get accountsWithAssertionIssues => {
    for (final issue in _assertionIssues)
      if (issue.accountName != null) issue.accountName!,
  };

  List<DoctorIssue> get _selectedAccountAssertionIssues {
    final accountName = _filter.account?.accountName;
    if (accountName == null) return const [];
    return [
      for (final issue in _assertionIssues)
        if (issue.accountName != null &&
            isAccountOrDescendant(issue.accountName!, accountName))
          issue,
    ];
  }

  Future<void> _load({String? pageToken}) async {
    if (_isLoading) return;
    final generation = _loadGuard.start();
    setState(() => _isLoading = true);
    await _doFetch(generation: generation, pageToken: pageToken);
  }

  Future<void> _openTransaction(TransactionResource tx) async {
    final result = await Navigator.push<TransactionEditResult>(
      context,
      MaterialPageRoute(
        builder: (_) => TransactionEditScreen(
          transaction: tx,
          transactionRepository: widget.transactionRepository,
          accountRepository: widget.accountRepository,
          commodityRepository: widget.commodityRepository,
          // The edit form itself always shows/edits raw values regardless —
          // this only steers the screen's post-save GET, so the row we get
          // back is already converted and this screen doesn't need its own
          // second round-trip to get one.
          defaultCurrency: _defaultCurrency,
        ),
      ),
    );
    if (result == null || !mounted) return;
    final (updated, refetchError) = result;
    setState(() {
      final idx = _transactions.indexWhere((t) => t.name == updated.name);
      if (idx >= 0) _transactions[idx] = updated;
      // The edit itself succeeded — surface a failed post-save re-fetch as
      // a banner rather than dropping it silently, while still showing the
      // best data available (the PATCH response) for the row.
      if (refetchError != null) {
        _errors[_ErrorSource.list] = refetchError;
      }
      // The edit may have changed amounts/postings on the charted
      // account; the chart has no other way to learn that.
      _chartRefreshTick++;
    });
    _refreshDoctorIssues();
  }

  // User-initiated (pull gesture, post-mutation, app-shell refresh): always
  // runs, even if pagination is in flight, and re-queries the chart too —
  // the data may have changed server-side with no other signal.
  Future<void> refresh() => _reload(bumpChartTick: true);

  // Sets _isLoading = true inside setState BEFORE jumpTo(0) so the synchronous
  // _onScroll callback fired by jumpTo sees _isLoading = true and bails.
  Future<void> _reload({required bool bumpChartTick}) async {
    if (_bulkActionBusy) return;
    final generation = _loadGuard.start();
    setState(() {
      _isLoading = true;
      _nextPageToken = null;
      _errors.remove(_ErrorSource.list);
      // Only clear the chart's error when the chart is also about to
      // reload (bumpChartTick) — otherwise its still-active failure would
      // vanish from the banner while nothing re-queries it.
      if (bumpChartTick) {
        _errors.remove(_ErrorSource.chart);
        _chartRefreshTick++;
      }
      _paginationError = false;
      _transactionsWithIssues = {};
    });
    if (_scrollController.hasClients) _scrollController.jumpTo(0);
    await _doFetch(generation: generation);
  }

  Future<void> openDateFilter() async {
    if (_filterSheetOpen) return;
    _filterSheetOpen = true;
    final result = await showDateFilterSheet(
      context,
      current: _filter,
      transactionRepository: widget.transactionRepository,
    );
    _filterSheetOpen = false;
    if (result != null && mounted) _applyFilter(result);
  }

  Future<void> openMoreFilters() async {
    if (_filterSheetOpen) return;
    _filterSheetOpen = true;
    final result = await showMoreFiltersSheet(
      context,
      current: _filter,
      commodityRepository: widget.commodityRepository,
    );
    _filterSheetOpen = false;
    if (result != null && mounted) _applyFilter(result);
  }

  // Applying a new filter value — from a sheet, a chart bucket tap, or
  // picking an account — is always the same choreography: drop any active
  // selection, persist, notify the app-bar badges, and reload. No chart
  // tick bump: account/view/date changes remount the card via its ValueKey
  // and the currency filter reaches it as a widget field, so a bump would
  // only force a second, identical chart query (worst case: toggling
  // last-import, which the chart's query doesn't consume at all).
  void _applyFilter(TransactionFilter next) {
    exitSelectionMode();
    _filter = next;
    unawaited(FilterPersistence.save(_filter));
    widget.filterNotifier?.value = _filter;
    _reload(bumpChartTick: false);
  }

  // Shared fetch. Caller must have started _loadGuard, set _isLoading = true,
  // and captured the generation value before any await.
  Future<void> _doFetch({required int generation, String? pageToken}) async {
    if (pageToken == null) _refreshDoctorIssues();
    final result = await widget.transactionRepository.listTransactions(
      pageToken: pageToken,
      filter: _filter,
      convert: _defaultCurrency,
    );
    if (!mounted) return;
    // superseded by a newer refresh
    if (!_loadGuard.isCurrent(generation)) return;
    if (result.error != null) {
      setState(() {
        // Distinguish by pageToken:
        // - null  → initial load or refresh  → ErrorBanner at top (always visible)
        // - non-null → pagination            → retry footer (user is near bottom)
        if (pageToken == null) {
          _errors[_ErrorSource.list] = result.error!;
        } else {
          _paginationError = true;
        }
        _isLoading = false;
      });
      return;
    }
    final (txs, nextToken) = result.data!;
    setState(() {
      _transactions = pageToken == null ? txs : [..._transactions, ...txs];
      _nextPageToken = nextToken;
      _paginationError = false;
      _isLoading = false;
    });
    // After layout: if the new items don't fill the viewport, _onScroll fires
    // immediately and loads the next page without requiring a user scroll gesture.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _onScroll();
    });
  }

  // Chart bucket tap: narrow the shared filter to that bucket. Same path as
  // applying the filter sheet — persist, notify, refresh.
  void _narrowToBucket(DateTime from, DateTime to) =>
      _applyFilter(_filter.copyWith(fromDate: from, toDate: to));

  // "Selecting an account" IS setting the account on the global filter —
  // used by the app bar title's account tap.
  void selectAccount(AccountResource account) =>
      _applyFilter(_filter.copyWith(account: account));

  // Selecting a home pseudo-view clears the account — this is the app's
  // "back to the home view" affordance.
  void selectHomeView(HomeView view) =>
      _applyFilter(_filter.copyWith(account: null, homeView: view));

  List<AccountResource> get pickerAccounts => buildPickerAccounts(_accounts);

  AccountResource? get selectedAccount => _filter.account;

  Future<void> openAccountPicker() async {
    final result = await Navigator.push<Object>(
      context,
      MaterialPageRoute(
        builder: (_) => AccountPickerScreen(
          accounts: pickerAccounts,
          selected: selectedAccount,
          issueAccountNames: accountsWithAssertionIssues,
          showHomeViews: true,
          selectedHomeView: _filter.account == null ? _filter.homeView : null,
        ),
      ),
    );
    if (!mounted) return;
    if (result is AccountResource) selectAccount(result);
    if (result is HomeView) selectHomeView(result);
  }

  Widget _buildChartCard() {
    final account = _filter.account;
    final spec = account != null
        ? ChartSpec.forAccount(account)
        : ChartSpec.forHomeView(_filter.homeView);
    return AccountChartCard(
      // The view or date range changing is a new view, not an update to the
      // same one — keying on them lets Flutter tear down and recreate the
      // card's State via a fresh initState, rather than the card having to
      // hand-detect "is this still the same view?" in didUpdateWidget.
      key: ValueKey((
        spec.id,
        _filter.fromDate?.toIso8601String(),
        _filter.toDate?.toIso8601String(),
      )),
      queryRepository: widget.queryRepository,
      spec: spec,
      fromDate: _filter.fromDate,
      toDate: _filter.toDate,
      defaultCurrency: _defaultCurrency,
      currencyFilter: _filter.currency,
      showsLastImportHint: _filter.lastImportOnly,
      refreshTick: _chartRefreshTick,
      onBucketSelected: _narrowToBucket,
      onError: (error) => setState(() {
        if (error != null) {
          _errors[_ErrorSource.chart] = error;
        } else {
          _errors.remove(_ErrorSource.chart);
        }
      }),
      // Doctor assertion overlays are per-account; home views show none.
      assertionIssues: account != null
          ? _selectedAccountAssertionIssues
          : const [],
    );
  }

  void _updateSelection(Set<String> next) {
    setState(() => _selectedNames = next);
    widget.selectionNotifier?.value = next;
  }

  void _enterSelection(TransactionResource tx) => _updateSelection({tx.name});

  void _toggleSelection(TransactionResource tx) {
    final next = Set<String>.from(_selectedNames);
    if (next.contains(tx.name)) {
      next.remove(tx.name);
    } else {
      next.add(tx.name);
    }
    _updateSelection(next);
  }

  void exitSelectionMode() {
    _bulkActionBusy = false;
    _updateSelection({});
  }

  Future<void> deleteSelected() async {
    if (_bulkActionBusy || _selectedNames.isEmpty) return;
    setState(() => _bulkActionBusy = true);
    final toDelete = Set<String>.from(_selectedNames);
    final errors = await Future.wait(
      toDelete.map(
        (name) => widget.transactionRepository.deleteTransaction(name),
      ),
    );
    if (!mounted) return;
    final firstError = errors.firstWhere((e) => e != null, orElse: () => null);
    if (firstError != null) {
      setState(() => _bulkActionBusy = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(firstError.displayMessage)));
      return;
    }
    setState(() {
      _transactions.removeWhere((t) => toDelete.contains(t.name));
      _chartRefreshTick++;
    });
    exitSelectionMode();
  }

  Future<void> mergeSelected() async {
    if (_bulkActionBusy || _selectedNames.length != 2) return;
    setState(() => _bulkActionBusy = true);
    final names = _selectedNames.toList();
    final mergeResult = await widget.transactionRepository.mergeTransactions(
      names[0],
      names[1],
    );
    if (!mounted) return;
    if (mergeResult.error != null) {
      setState(() => _bulkActionBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(mergeResult.error!.displayMessage)),
      );
      return;
    }
    final deleteErrors = await Future.wait(
      names.map((name) => widget.transactionRepository.deleteTransaction(name)),
    );
    if (!mounted) return;
    final firstError = deleteErrors.firstWhere(
      (e) => e != null,
      orElse: () => null,
    );
    if (firstError != null) {
      setState(() => _bulkActionBusy = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(firstError.displayMessage)));
      return;
    }
    final mergedTx = mergeResult.data!;
    final toRemove = Set<String>.from(names);
    setState(() {
      final primaryIdx = _transactions.indexWhere((t) => t.name == names[0]);
      final secondaryIdx = _transactions.indexWhere((t) => t.name == names[1]);
      final insertAt = primaryIdx < 0
          ? 0
          : (primaryIdx -
                    (secondaryIdx >= 0 && secondaryIdx < primaryIdx ? 1 : 0))
                .clamp(0, _transactions.length - toRemove.length);
      _transactions.removeWhere((t) => toRemove.contains(t.name));
      _transactions.insert(insertAt, mergedTx);
      _chartRefreshTick++;
    });
    exitSelectionMode();
  }

  @override
  Widget build(BuildContext context) {
    // No fetch has ever started, so the persisted filter hasn't been
    // restored yet (the first _load comes from _restoreFilter). Building
    // the real UI now would flash the default view — wrong chart, wrong
    // app-bar spec — for the frames until prefs resolve.
    if (!_loadGuard.hasStarted) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }

    // The chart card always leads the list: an account view when one is
    // selected, the home pseudo-view (balance sheet / income statement)
    // otherwise — even when there are no transactions.

    // Footer spinner covers two loading cases (mutually exclusive, same
    // widget either way): mid-pagination, and the very first fetch when
    // there's no default currency for the chart to show its own spinner
    // instead (it shows a placeholder then, so the list needs its own cue).
    // Any other initial load already has the chart's spinner as its cue —
    // it always leads the list — so this doesn't also fire then.
    final showLoadingFooter =
        _isLoading &&
        (_nextPageToken != null ||
            (_transactions.isEmpty && _defaultCurrency == null));
    final isSelecting = _selectedNames.isNotEmpty;
    // Never claim the range is empty while the list's OWN fetch errored —
    // it didn't actually succeed, so "no transactions" isn't true. A
    // chart-only error doesn't affect this: the list can be genuinely
    // empty even while the chart's independent query is failing.
    final showEmptyState =
        _transactions.isEmpty &&
        !_isLoading &&
        !_errors.containsKey(_ErrorSource.list);
    final hasTrailing = showLoadingFooter || _paginationError || showEmptyState;

    Widget listContent = RefreshIndicator(
      onRefresh: refresh,
      displacement: 60.0,
      child: ListView.builder(
        controller: _scrollController,
        physics: const AlwaysScrollableScrollPhysics(
          parent: ClampingScrollPhysics(),
        ),
        itemCount: 1 + _transactions.length + (hasTrailing ? 1 : 0),
        itemBuilder: (context, index) {
          if (index == 0) return _buildChartCard();
          final txIndex = index - 1;
          if (txIndex == _transactions.length) {
            if (showLoadingFooter) {
              return const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              );
            }
            if (_paginationError) {
              return Center(
                child: TextButton(
                  onPressed: () {
                    setState(() => _paginationError = false);
                    _load(
                      pageToken: _nextPageToken,
                    ); // reuses preserved token — does not reset to page 1
                  },
                  child: const Text('Retry'),
                ),
              );
            }
            return const Padding(
              padding: EdgeInsets.symmetric(vertical: 32),
              child: Center(
                child: Text(
                  'No transactions in range',
                  style: TextStyle(fontSize: 15, color: Color(0xFF8E8E93)),
                ),
              ),
            );
          }
          final tx = _transactions[txIndex];
          return _TransactionRow(
            transaction: tx,
            amountRoots: _filter.viewRoots,
            convertTarget: _defaultCurrency,
            hasIssue: _transactionsWithIssues.contains(tx.name),
            isSelecting: isSelecting,
            isSelected: _selectedNames.contains(tx.name),
            onTap: isSelecting
                ? () => _toggleSelection(tx)
                : () => _openTransaction(tx),
            onLongPress: () => _enterSelection(tx),
          );
        },
      ),
    );

    // Refresh failure with existing data: ErrorBanner at top (always visible after
    // jumpTo(0)), list below. Footer would be off-screen, so banner is required.
    return Column(
      children: [
        if (_error != null) ErrorBanner(error: _error!, onRetry: refresh),
        Expanded(child: listContent),
      ],
    );
  }
}

class _TransactionRow extends StatelessWidget {
  final TransactionResource transaction;

  /// Subtree roots of the current view — the displayed amount is the sum
  /// of this transaction's postings under them (raw ledger signs).
  final List<String> amountRoots;

  /// Currency the server converted foreign postings to (the app's default
  /// currency), or null when none is configured.
  final String? convertTarget;

  final bool hasIssue;
  final bool isSelecting;
  final bool isSelected;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  const _TransactionRow({
    required this.transaction,
    required this.amountRoots,
    required this.convertTarget,
    required this.hasIssue,
    required this.isSelecting,
    required this.isSelected,
    required this.onTap,
    required this.onLongPress,
  });

  static final _dateFormatCurrentYear = DateFormat('MMM d');
  static final _dateFormatOtherYear = DateFormat('MMM d, yyyy');

  String _formatDate(String isoDate) {
    final dt = DateTime.tryParse(isoDate);
    if (dt == null) return isoDate;
    final fmt = dt.year == DateTime.now().year
        ? _dateFormatCurrentYear
        : _dateFormatOtherYear;
    return fmt.format(dt);
  }

  static String _joinSums(Map<String, double> sums) =>
      (sums.entries.toList()..sort((a, b) => a.key.compareTo(b.key)))
          .map((e) => '${formatFixedAmount(e.value)} ${e.key}')
          .join(' · ');

  /// The view's posting sum: converted total plus any unconvertible raw
  /// per-currency sums (rare, joined on one line). '—' when no posting of
  /// this transaction falls under the view's roots (e.g. an Equity-only
  /// transaction on a home view).
  String _formatAmount(PostingSums sums) {
    final parts = <String>[
      if (sums.converted != null)
        '${formatFixedAmount(sums.converted!)} $convertTarget',
      if (sums.unconverted.isNotEmpty) _joinSums(sums.unconverted),
    ];
    return parts.isEmpty ? '—' : parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final primaryText = transaction.payee ?? transaction.narration ?? '—';
    final secondaryText =
        (transaction.payee != null && transaction.narration != null)
        ? transaction.narration
        : null;
    final sums = sumPostings(
      transaction.postings,
      amountRoots,
      target: convertTarget,
    );

    final rowColor = isSelected ? const Color(0xFFE8F0FE) : Colors.white;
    final selectionIcon = isSelected
        ? Icons.check_circle
        : Icons.radio_button_unchecked;
    final selectionColor = isSelected
        ? const Color(0xFF1A73E8)
        : const Color(0xFF8E8E93);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Stack(
          children: [
            InkWell(
              onTap: onTap,
              onLongPress: onLongPress,
              child: ColoredBox(
                color: rowColor,
                child: SizedBox(
                  height: 88,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 12,
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (isSelecting)
                          SizedBox(
                            width: 18,
                            height: 18,
                            child: Icon(
                              selectionIcon,
                              size: 18,
                              color: selectionColor,
                            ),
                          )
                        else
                          _PostingPills(postings: transaction.postings),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                primaryText,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w500,
                                  color: Color(0xFF1C1C1E),
                                ),
                              ),
                              if (secondaryText != null) ...[
                                const SizedBox(height: 2),
                                Text(
                                  secondaryText,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w400,
                                    color: Color(0xFF8E8E93),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              _formatAmount(sums),
                              style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w500,
                                color: Color(0xFF1C1C1E),
                              ),
                            ),
                            if (sums.originals.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              // The pre-conversion original amounts.
                              Text(
                                _joinSums(sums.originals),
                                style: const TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w400,
                                  color: Color(0xFF8E8E93),
                                ),
                              ),
                            ],
                            const SizedBox(height: 2),
                            Text(
                              _formatDate(transaction.transactionDate),
                              style: const TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w400,
                                color: Color(0xFF8E8E93),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            if (hasIssue)
              const Positioned(left: 0, top: 0, bottom: 0, child: IssueBar()),
          ],
        ),
        const Divider(
          height: 1,
          thickness: 1,
          indent: 16,
          color: Color(0xFFE5E5EA),
        ),
      ],
    );
  }
}

// Vertically overlapping pill column. Fixed width keeps text left-edge aligned.
// Pills: 18 px circles, 7 px overlap → step of 11 px between tops.
// Max 5 slots: 4 category pills + 1 "+N" overflow circle if needed.
// 5-slot height = 18 + 4×11 = 62 px, within the 64 px content area.
class _PostingPills extends StatelessWidget {
  final List<PostingResource> postings;

  static const _size = 18.0;
  static const _step = 11.0; // size − 7 px overlap
  static const _maxSlots = 5;

  const _PostingPills({required this.postings});

  @override
  Widget build(BuildContext context) {
    final cats = postings.map((p) => categoryOf(p.accountName)).toList();
    final hasOverflow = cats.length > _maxSlots;
    final pillCount = hasOverflow
        ? _maxSlots - 1
        : cats.length.clamp(0, _maxSlots);
    final overflow = cats.length - pillCount;
    final totalSlots = pillCount + (hasOverflow ? 1 : 0);
    final containerHeight = _size + (totalSlots - 1) * _step;

    return SizedBox(
      width: _size,
      height: containerHeight,
      child: Stack(
        children: [
          for (var i = 0; i < pillCount; i++)
            Positioned(
              top: i * _step,
              child: AccountCategoryDot(
                theme: accountCategoryThemes[cats[i]]!,
                size: _PostingPills._size,
                iconSize: 10,
              ),
            ),
          if (hasOverflow)
            Positioned(
              top: pillCount * _step,
              child: _OverflowPill(count: overflow),
            ),
        ],
      ),
    );
  }
}

class _OverflowPill extends StatelessWidget {
  final int count;

  const _OverflowPill({required this.count});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: _PostingPills._size,
      height: _PostingPills._size,
      decoration: const BoxDecoration(
        color: Color(0xFFE5E5EA),
        shape: BoxShape.circle,
      ),
      child: Center(
        child: Text(
          '+$count',
          style: const TextStyle(
            fontSize: 7,
            fontWeight: FontWeight.w700,
            color: Color(0xFF8E8E93),
          ),
        ),
      ),
    );
  }
}
