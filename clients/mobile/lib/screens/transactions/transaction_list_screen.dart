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
import '../../models/doctor_issue.dart';
import '../../models/transaction.dart';
import '../../repositories/account_repository.dart';
import '../../repositories/commodity_repository.dart';
import '../../repositories/query_repository.dart';
import '../../repositories/transaction_repository.dart';
import '../../widgets/account_chart_card.dart';
import '../../widgets/error_banner.dart';
import '../../widgets/issue_bar.dart';
import '../transaction_edit/transaction_edit_screen.dart';
import 'transaction_filter.dart';
import 'transaction_filter_sheet.dart';

class TransactionListScreen extends StatefulWidget {
  final TransactionRepository transactionRepository;
  final AccountRepository accountRepository;
  final CommodityRepository commodityRepository;
  final QueryRepository queryRepository;
  final ValueNotifier<bool>? filterActiveNotifier;
  final ValueNotifier<Set<String>>? selectionNotifier;

  const TransactionListScreen({
    super.key,
    required this.transactionRepository,
    required this.accountRepository,
    required this.commodityRepository,
    required this.queryRepository,
    this.filterActiveNotifier,
    this.selectionNotifier,
  });

  @override
  TransactionListScreenState createState() => TransactionListScreenState();
}

class TransactionListScreenState extends State<TransactionListScreen> {
  final _scrollController = ScrollController();

  List<TransactionResource> _transactions = [];
  String? _nextPageToken;
  bool _isLoading = false;
  ApiError? _error;
  bool _paginationError = false;

  // Incremented on each new fetch; _doFetch discards results from older generations.
  int _loadGeneration = 0;

  Set<String> _transactionsWithIssues = {};
  List<DoctorIssue> _assertionIssues = const [];
  int _doctorGeneration = 0;

  TransactionFilter _filter = const TransactionFilter();
  List<AccountResource> _accounts = const [];
  bool _filterOpen = false;

  String _defaultCurrency = 'CHF';
  int _chartRefreshTick = 0;

  Set<String> _selectedNames = {};
  bool _bulkActionBusy = false;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    _restoreFilter();
    _prefetchAccounts();
    _loadDefaultCurrency();
  }

  Future<void> _restoreFilter() async {
    final saved = await FilterPersistence.load();
    if (!mounted) return;
    _filter = saved;
    widget.filterActiveNotifier?.value = _filter.isActive;
    _load();
  }

  Future<void> _loadDefaultCurrency() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    final stored = prefs.getString(AppPreferences.keyDefaultCurrency);
    if (stored != null && stored.isNotEmpty && stored != _defaultCurrency) {
      setState(() => _defaultCurrency = stored);
    }
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
    _doctorGeneration++;
    final gen = _doctorGeneration;
    widget.transactionRepository.runDoctorIssues().then((result) {
      if (!mounted || _doctorGeneration != gen) return;
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
    _loadGeneration++;
    final generation = _loadGeneration;
    setState(() => _isLoading = true);
    await _doFetch(generation: generation, pageToken: pageToken);
  }

  Future<void> _openTransaction(TransactionResource tx) async {
    final updated = await Navigator.push<TransactionResource>(
      context,
      MaterialPageRoute(
        builder: (_) => TransactionEditScreen(
          transaction: tx,
          transactionRepository: widget.transactionRepository,
          accountRepository: widget.accountRepository,
          commodityRepository: widget.commodityRepository,
        ),
      ),
    );
    if (updated != null && mounted) {
      setState(() {
        final idx = _transactions.indexWhere((t) => t.name == updated.name);
        if (idx >= 0) _transactions[idx] = updated;
        // The edit may have changed amounts/postings on the charted
        // account; the chart has no other way to learn that.
        _chartRefreshTick++;
      });
      _refreshDoctorIssues();
    }
  }

  // User-initiated: always runs, even if pagination is in flight.
  // Sets _isLoading = true inside setState BEFORE jumpTo(0) so the synchronous
  // _onScroll callback fired by jumpTo sees _isLoading = true and bails.
  Future<void> refresh() async {
    if (_bulkActionBusy) return;
    _loadGeneration++;
    final generation = _loadGeneration;
    setState(() {
      _isLoading = true;
      _nextPageToken = null;
      _error = null;
      _paginationError = false;
      _transactionsWithIssues = {};
      _chartRefreshTick++;
    });
    if (_scrollController.hasClients) _scrollController.jumpTo(0);
    await _doFetch(generation: generation);
  }

  Future<void> openFilter() async {
    if (_filterOpen) return;
    _filterOpen = true;
    final result = await showTransactionFilterSheet(
      context,
      accounts: _accounts,
      current: _filter,
      transactionRepository: widget.transactionRepository,
      commodityRepository: widget.commodityRepository,
    );
    _filterOpen = false;
    if (result != null && mounted) _applyFilter(result);
  }

  // Applying a new filter value — from the sheet, a chart bucket tap, or
  // picking an account — is always the same choreography: drop any active
  // selection, persist, notify the app-bar dot, and reload.
  void _applyFilter(TransactionFilter next) {
    exitSelectionMode();
    _filter = next;
    unawaited(FilterPersistence.save(_filter));
    widget.filterActiveNotifier?.value = _filter.isActive;
    refresh();
  }

  // Shared fetch. Caller must have incremented _loadGeneration, set _isLoading = true,
  // and captured the generation value before any await.
  Future<void> _doFetch({required int generation, String? pageToken}) async {
    if (pageToken == null) _refreshDoctorIssues();
    final result = await widget.transactionRepository.listTransactions(
      pageToken: pageToken,
      filter: _filter,
    );
    if (!mounted) return;
    if (_loadGeneration != generation) return; // superseded by a newer refresh
    if (result.error != null) {
      setState(() {
        // Distinguish by pageToken:
        // - null  → initial load or refresh  → ErrorBanner at top (always visible)
        // - non-null → pagination            → retry footer (user is near bottom)
        if (pageToken == null) {
          _error = result.error;
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
  // used by the drawer's Accounts entry.
  void selectAccount(AccountResource account) =>
      _applyFilter(_filter.copyWith(account: account));

  List<AccountResource> get pickerAccounts => buildPickerAccounts(_accounts);

  AccountResource? get selectedAccount => _filter.account;

  Widget _buildChartCard() {
    return AccountChartCard(
      queryRepository: widget.queryRepository,
      account: _filter.account!,
      fromDate: _filter.fromDate,
      toDate: _filter.toDate,
      rangeLabel: _filter.dateRangeLabel,
      defaultCurrency: _defaultCurrency,
      currencyFilter: _filter.currency,
      showsLastImportHint: _filter.lastImportOnly,
      refreshTick: _chartRefreshTick,
      onBucketSelected: _narrowToBucket,
      assertionIssues: _selectedAccountAssertionIssues,
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
    // With an account selected, the home list becomes the account view: the
    // chart card leads the list, even when there are no transactions.
    final hasChart = _filter.account != null;

    if (_error != null && _transactions.isEmpty && !hasChart) {
      return ErrorBanner(error: _error!, onRetry: refresh);
    }

    if (_transactions.isEmpty && !hasChart) {
      if (_isLoading) {
        return const Center(child: CircularProgressIndicator(strokeWidth: 2));
      }
      return const Center(
        child: Text(
          'No transactions yet',
          style: TextStyle(fontSize: 15, color: Color(0xFF8E8E93)),
        ),
      );
    }

    // Bottom spinner only during pagination. During refresh, _nextPageToken is reset
    // to null before _isLoading = true, so this stays false and only
    // RefreshIndicator's own top indicator shows — except RefreshIndicator's
    // spinner only appears for a user pull gesture, not a programmatic
    // refresh() (e.g. the initial load right after selecting an account),
    // so a hasChart initial/empty load needs its own visible cue here.
    final showBottomSpinner = _isLoading && _nextPageToken != null;
    final showInitialChartLoading =
        hasChart &&
        _isLoading &&
        _transactions.isEmpty &&
        _nextPageToken == null;
    final isSelecting = _selectedNames.isNotEmpty;
    final leading = hasChart ? 1 : 0;
    // Never claim the range is empty while a load error is still showing —
    // the fetch didn't actually succeed, so "no transactions" isn't true.
    final showEmptyState =
        hasChart && _transactions.isEmpty && !_isLoading && _error == null;
    final hasTrailing =
        showBottomSpinner ||
        _paginationError ||
        showInitialChartLoading ||
        showEmptyState;

    Widget listContent = RefreshIndicator(
      onRefresh: refresh,
      displacement: 60.0,
      child: ListView.builder(
        controller: _scrollController,
        physics: const AlwaysScrollableScrollPhysics(
          parent: ClampingScrollPhysics(),
        ),
        itemCount: leading + _transactions.length + (hasTrailing ? 1 : 0),
        itemBuilder: (context, index) {
          if (hasChart && index == 0) return _buildChartCard();
          final txIndex = index - leading;
          if (txIndex == _transactions.length) {
            if (showBottomSpinner || showInitialChartLoading) {
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
  final bool hasIssue;
  final bool isSelecting;
  final bool isSelected;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  const _TransactionRow({
    required this.transaction,
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

  String _formatAmount() {
    if (transaction.postings.isEmpty) return '—';
    final posting = transaction.postings.first;
    final raw = double.tryParse(posting.units.amount);
    if (raw == null) return '${posting.units.amount} ${posting.units.symbol}';
    return '${formatFixedAmount(raw)} ${posting.units.symbol}';
  }

  @override
  Widget build(BuildContext context) {
    final primaryText = transaction.payee ?? transaction.narration ?? '—';
    final secondaryText =
        (transaction.payee != null && transaction.narration != null)
        ? transaction.narration
        : null;

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
                              _formatAmount(),
                              style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w500,
                                color: Color(0xFF1C1C1E),
                              ),
                            ),
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
              child: _PillCircle(category: cats[i]),
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

class _PillCircle extends StatelessWidget {
  final AccountCategory category;

  const _PillCircle({required this.category});

  @override
  Widget build(BuildContext context) {
    final theme = accountCategoryThemes[category]!;
    return Container(
      width: _PostingPills._size,
      height: _PostingPills._size,
      decoration: BoxDecoration(color: theme.color, shape: BoxShape.circle),
      child: Icon(theme.icon, size: 10, color: Colors.white),
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
