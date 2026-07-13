import 'package:flutter/material.dart';
import '../../core/account_category.dart';
import '../../core/account_hierarchy.dart';
import '../../core/account_search.dart';
import '../../core/home_view.dart';
import '../../models/account.dart';
import '../../widgets/account_category_dot.dart';
import '../../widgets/issue_bar.dart';

class AccountPickerScreen extends StatefulWidget {
  final List<AccountResource> accounts;
  final AccountResource? selected;

  /// Account names whose subtree has failed balance assertions (from
  /// doctor); marked with the same red bar as problem transactions.
  final Set<String> issueAccountNames;

  /// Pins the home pseudo-views (balance sheet / income statement) at the
  /// top of the list. Only the transaction-list navigation flow opts in —
  /// posting-editing flows pick real accounts. Picking one pops a
  /// [HomeView] instead of an [AccountResource].
  final bool showHomeViews;

  /// The home view currently shown, for its checkmark; null when an
  /// account is selected instead.
  final HomeView? selectedHomeView;

  const AccountPickerScreen({
    super.key,
    required this.accounts,
    this.selected,
    this.issueAccountNames = const {},
    this.showHomeViews = false,
    this.selectedHomeView,
  });

  @override
  State<AccountPickerScreen> createState() => _AccountPickerScreenState();
}

class _AccountPickerScreenState extends State<AccountPickerScreen> {
  final _searchController = TextEditingController();
  List<AccountResource> _filtered = [];
  String _lastQuery = '';
  bool _showClosed = false;

  bool get _hasClosedAccounts => widget.accounts.any((a) => !a.isActive);

  // Synthetic prefix entries always look active and must never be hidden;
  // the current selection is always shown too, even if closed, so it isn't
  // silently hidden with no checkmark and no way to confirm/re-pick it.
  List<AccountResource> get _visibleAccounts => _showClosed
      ? widget.accounts
      : widget.accounts
            .where(
              (a) =>
                  a.isActive || a.isPrefix || a.name == widget.selected?.name,
            )
            .toList();

  @override
  void initState() {
    super.initState();
    _filtered = _visibleAccounts;
    _searchController.addListener(_onSearch);
  }

  void _refilter() {
    _filtered = filterAccounts(_visibleAccounts, _searchController.text);
  }

  void _onSearch() {
    final query = _searchController.text;
    if (query == _lastQuery) return;
    _lastQuery = query;
    setState(_refilter);
  }

  // An account is marked when it, a descendant, or (for prefix rows) any
  // account in its subtree has a failed balance assertion.
  bool _hasIssue(AccountResource account) => widget.issueAccountNames.any(
    (name) => isAccountOrDescendant(name, account.accountName),
  );

  // Hidden while searching so fuzzy account results stay uncluttered.
  List<HomeView> get _pinnedViews =>
      widget.showHomeViews && _searchController.text.isEmpty
      ? HomeView.values
      : const [];

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF2F2F7),
      appBar: AppBar(
        leading: TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text(
            'Cancel',
            style: TextStyle(color: Color(0xFF1A73E8)),
          ),
        ),
        leadingWidth: 80,
        title: const Text('Select Account'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1C1C1E),
        elevation: 0,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: const Color(0xFFE5E5EA)),
        ),
      ),
      body: Column(
        children: [
          Container(
            color: Colors.white,
            padding: const EdgeInsets.all(12),
            child: TextField(
              controller: _searchController,
              autofocus: true,
              decoration: InputDecoration(
                hintText: 'Search accounts…',
                prefixIcon: const Icon(
                  Icons.search,
                  size: 20,
                  color: Color(0xFF8E8E93),
                ),
                filled: true,
                fillColor: const Color(0xFFF2F2F7),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide.none,
                ),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 8),
              ),
            ),
          ),
          if (_hasClosedAccounts)
            Container(
              color: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  const Text(
                    'Show closed accounts',
                    style: TextStyle(fontSize: 13, color: Color(0xFF8E8E93)),
                  ),
                  const Spacer(),
                  Switch.adaptive(
                    value: _showClosed,
                    onChanged: (value) => setState(() {
                      _showClosed = value;
                      _refilter();
                    }),
                  ),
                ],
              ),
            ),
          Expanded(
            child: ListView.builder(
              itemCount: _pinnedViews.length + _filtered.length,
              itemBuilder: (context, i) {
                if (i < _pinnedViews.length) {
                  final view = _pinnedViews[i];
                  return _HomeViewItem(
                    view: view,
                    isSelected: view == widget.selectedHomeView,
                    isLast: i == _pinnedViews.length - 1,
                    onTap: () => Navigator.pop(context, view),
                  );
                }
                final account = _filtered[i - _pinnedViews.length];
                final isSelected = account.name == widget.selected?.name;
                return _AccountItem(
                  account: account,
                  isSelected: isSelected,
                  hasIssue: _hasIssue(account),
                  query: _searchController.text,
                  onTap: () => Navigator.pop(context, account),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// Shared row shell for picker entries: dot, label, optional checkmark,
/// bottom divider.
class _PickerRow extends StatelessWidget {
  final AccountCategoryTheme theme;
  final Widget label;
  final bool isSelected;
  final Color dividerColor;
  final VoidCallback onTap;

  const _PickerRow({
    required this.theme,
    required this.label,
    required this.isSelected,
    required this.onTap,
    this.dividerColor = const Color(0xFFF2F2F7),
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border(bottom: BorderSide(color: dividerColor)),
        ),
        child: Row(
          children: [
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: AccountCategoryDot(theme: theme, size: 10),
            ),
            Expanded(child: label),
            if (isSelected)
              const Icon(Icons.check, color: Color(0xFF1A73E8), size: 18),
          ],
        ),
      ),
    );
  }
}

/// A pinned home pseudo-view row, with a stronger divider after the last
/// one to separate the views section from real accounts.
class _HomeViewItem extends StatelessWidget {
  final HomeView view;
  final bool isSelected;
  final bool isLast;
  final VoidCallback onTap;

  const _HomeViewItem({
    required this.view,
    required this.isSelected,
    required this.isLast,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return _PickerRow(
      theme: themeForHomeView(view),
      isSelected: isSelected,
      dividerColor: isLast ? const Color(0xFFE5E5EA) : const Color(0xFFF2F2F7),
      onTap: onTap,
      label: Text(
        view.label,
        style: const TextStyle(fontSize: 15, color: Color(0xFF1C1C1E)),
      ),
    );
  }
}

class _AccountItem extends StatelessWidget {
  final AccountResource account;
  final bool isSelected;
  final bool hasIssue;
  final String query;
  final VoidCallback onTap;

  const _AccountItem({
    required this.account,
    required this.isSelected,
    required this.hasIssue,
    required this.query,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        _PickerRow(
          theme: themeForAccount(account.accountName),
          isSelected: isSelected,
          onTap: onTap,
          label: _HighlightedText(
            text: account.displayName,
            query: query,
            dimmed: account.isPrefix || !account.isActive,
          ),
        ),
        if (hasIssue)
          const Positioned(left: 0, top: 0, bottom: 0, child: IssueBar()),
      ],
    );
  }
}

class _HighlightedText extends StatelessWidget {
  final String text;
  final String query;
  final bool dimmed;

  const _HighlightedText({
    required this.text,
    required this.query,
    this.dimmed = false,
  });

  @override
  Widget build(BuildContext context) {
    final baseColor = dimmed
        ? const Color(0xFF8E8E93)
        : const Color(0xFF1C1C1E);
    if (query.isEmpty) {
      return Text(text, style: TextStyle(fontSize: 15, color: baseColor));
    }
    // Build spans: highlight matched characters in order.
    final spans = <TextSpan>[];
    final lowerText = text.toLowerCase();
    final lowerQuery = query.toLowerCase();
    int qi = 0;
    int lastEnd = 0;
    for (int i = 0; i < lowerText.length && qi < lowerQuery.length; i++) {
      if (lowerText[i] == lowerQuery[qi]) {
        if (i > lastEnd) {
          spans.add(TextSpan(text: text.substring(lastEnd, i)));
        }
        spans.add(
          TextSpan(
            text: text.substring(i, i + 1),
            style: const TextStyle(
              color: Color(0xFF1A73E8),
              fontWeight: FontWeight.w600,
            ),
          ),
        );
        lastEnd = i + 1;
        qi++;
      }
    }
    if (lastEnd < text.length) {
      spans.add(TextSpan(text: text.substring(lastEnd)));
    }
    return RichText(
      text: TextSpan(
        style: TextStyle(fontSize: 15, color: baseColor),
        children: spans,
      ),
    );
  }
}
