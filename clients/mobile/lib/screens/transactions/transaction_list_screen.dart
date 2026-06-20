import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../core/account_category.dart';
import '../../core/api_error.dart';
import '../../models/transaction.dart';
import '../../repositories/account_repository.dart';
import '../../repositories/commodity_repository.dart';
import '../../repositories/transaction_repository.dart';
import '../../widgets/error_banner.dart';
import '../transaction_edit/transaction_edit_screen.dart';

class TransactionListScreen extends StatefulWidget {
  final TransactionRepository transactionRepository;
  final AccountRepository accountRepository;
  final CommodityRepository commodityRepository;

  const TransactionListScreen({
    super.key,
    required this.transactionRepository,
    required this.accountRepository,
    required this.commodityRepository,
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
  int _doctorGeneration = 0;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    _load();
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

  void _refreshDoctorIssues() {
    _doctorGeneration++;
    final gen = _doctorGeneration;
    widget.transactionRepository.runDoctor().then((result) {
      if (!mounted || _doctorGeneration != gen) return;
      if (result.data != null) {
        final newIssues = result.data!;
        if (newIssues.length != _transactionsWithIssues.length ||
            !_transactionsWithIssues.containsAll(newIssues)) {
          setState(() => _transactionsWithIssues = newIssues);
        }
      }
    });
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
      });
      _refreshDoctorIssues();
    }
  }

  // User-initiated: always runs, even if pagination is in flight.
  // Sets _isLoading = true inside setState BEFORE jumpTo(0) so the synchronous
  // _onScroll callback fired by jumpTo sees _isLoading = true and bails.
  Future<void> refresh() async {
    _loadGeneration++;
    final generation = _loadGeneration;
    setState(() {
      _isLoading = true;
      _nextPageToken = null;
      _error = null;
      _paginationError = false;
      _transactionsWithIssues = {};
    });
    if (_scrollController.hasClients) _scrollController.jumpTo(0);
    await _doFetch(generation: generation);
  }

  // Shared fetch. Caller must have incremented _loadGeneration, set _isLoading = true,
  // and captured the generation value before any await.
  Future<void> _doFetch({required int generation, String? pageToken}) async {
    if (pageToken == null) _refreshDoctorIssues();
    final result = await widget.transactionRepository.listTransactions(
      pageToken: pageToken,
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

  @override
  Widget build(BuildContext context) {
    if (_error != null && _transactions.isEmpty) {
      return Column(
        children: [ErrorBanner(error: _error!, onRetry: refresh)],
      );
    }

    if (_transactions.isEmpty) {
      return _isLoading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : const Center(
              child: Text(
                'No transactions yet',
                style: TextStyle(fontSize: 15, color: Color(0xFF8E8E93)),
              ),
            );
    }

    // Bottom spinner only during pagination. During refresh, _nextPageToken is reset
    // to null before _isLoading = true, so this stays false and only
    // RefreshIndicator's own top indicator shows.
    final showBottomSpinner = _isLoading && _nextPageToken != null;

    Widget listContent = RefreshIndicator(
      onRefresh: refresh,
      displacement: 60.0,
      child: ListView.builder(
        controller: _scrollController,
        physics: const AlwaysScrollableScrollPhysics(
          parent: ClampingScrollPhysics(),
        ),
        itemCount:
            _transactions.length +
            (showBottomSpinner || _paginationError ? 1 : 0),
        itemBuilder: (context, index) {
          if (index == _transactions.length) {
            if (showBottomSpinner) {
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
          return _TransactionRow(
            transaction: _transactions[index],
            hasIssue: _transactionsWithIssues.contains(
              _transactions[index].name,
            ),
            onTap: () => _openTransaction(_transactions[index]),
          );
        },
      ),
    );

    // Refresh failure with existing data: ErrorBanner at top (always visible after
    // jumpTo(0)), list below. Footer would be off-screen, so banner is required.
    if (_error != null) {
      return Column(
        children: [
          ErrorBanner(error: _error!, onRetry: refresh),
          Expanded(child: listContent),
        ],
      );
    }
    return listContent;
  }
}

class _TransactionRow extends StatelessWidget {
  final TransactionResource transaction;
  final bool hasIssue;
  final VoidCallback onTap;

  const _TransactionRow({
    required this.transaction,
    required this.hasIssue,
    required this.onTap,
  });

  static final _dateFormatCurrentYear = DateFormat('MMM d');
  static final _dateFormatOtherYear = DateFormat('MMM d, yyyy');
  static final _amountFormat = NumberFormat('#,##0.00');

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
    return '${_amountFormat.format(raw)} ${posting.units.symbol}';
  }

  @override
  Widget build(BuildContext context) {
    final primaryText = transaction.payee ?? transaction.narration ?? '—';
    final secondaryText =
        (transaction.payee != null && transaction.narration != null)
        ? transaction.narration
        : null;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Stack(
          children: [
            InkWell(
              onTap: onTap,
              child: ColoredBox(
                color: Colors.white,
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
              const Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                child: SizedBox(
                  width: 4,
                  child: ColoredBox(color: Color(0xFFFF3B30)),
                ),
              ),
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
