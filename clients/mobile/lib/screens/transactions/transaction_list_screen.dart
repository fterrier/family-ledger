import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../core/api_error.dart';
import '../../models/transaction.dart';
import '../../repositories/transaction_repository.dart';
import '../../widgets/error_banner.dart';

class TransactionListScreen extends StatefulWidget {
  final TransactionRepository transactionRepository;

  const TransactionListScreen({super.key, required this.transactionRepository});

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

  Future<void> _load({String? pageToken}) async {
    if (_isLoading) return;
    _loadGeneration++;
    final generation = _loadGeneration;
    setState(() => _isLoading = true);
    await _doFetch(generation: generation, pageToken: pageToken);
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
    });
    if (_scrollController.hasClients) _scrollController.jumpTo(0);
    await _doFetch(generation: generation);
  }

  // Shared fetch. Caller must have incremented _loadGeneration, set _isLoading = true,
  // and captured the generation value before any await.
  Future<void> _doFetch({required int generation, String? pageToken}) async {
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

    Widget listContent = ScrollConfiguration(
      behavior: const _NoOverscrollBehavior(),
      child: RefreshIndicator(
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
            return _TransactionRow(transaction: _transactions[index]);
          },
        ),
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

// Removes Material 3's StretchingOverscrollIndicator (Android) and
// GlowingOverscrollIndicator (older Android) without affecting RefreshIndicator,
// which operates at the gesture layer independently of these visual effects.
class _NoOverscrollBehavior extends ScrollBehavior {
  const _NoOverscrollBehavior();

  @override
  Widget buildOverscrollIndicator(
    BuildContext context,
    Widget child,
    ScrollableDetails details,
  ) => child;
}

class _TransactionRow extends StatelessWidget {
  final TransactionResource transaction;

  const _TransactionRow({required this.transaction});

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
        SizedBox(
          height: 88,
          child: ColoredBox(
            color: Colors.white,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
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
