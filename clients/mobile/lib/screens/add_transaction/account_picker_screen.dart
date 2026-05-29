import 'package:flutter/material.dart';
import '../../core/account_search.dart';
import '../../models/account.dart';

class AccountPickerScreen extends StatefulWidget {
  final List<AccountResource> accounts;
  final AccountResource? selected;

  const AccountPickerScreen({super.key, required this.accounts, this.selected});

  @override
  State<AccountPickerScreen> createState() => _AccountPickerScreenState();
}

class _AccountPickerScreenState extends State<AccountPickerScreen> {
  final _searchController = TextEditingController();
  List<AccountResource> _filtered = [];
  String _lastQuery = '';

  @override
  void initState() {
    super.initState();
    _filtered = widget.accounts;
    _searchController.addListener(_onSearch);
  }

  void _onSearch() {
    final query = _searchController.text;
    if (query == _lastQuery) return;
    _lastQuery = query;
    setState(() {
      _filtered = filterAccounts(widget.accounts, query);
    });
  }

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
          Expanded(
            child: ListView.builder(
              itemCount: _filtered.length,
              itemBuilder: (context, i) {
                final account = _filtered[i];
                final isSelected = account.name == widget.selected?.name;
                return _AccountItem(
                  account: account,
                  isSelected: isSelected,
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

class _AccountItem extends StatelessWidget {
  final AccountResource account;
  final bool isSelected;
  final String query;
  final VoidCallback onTap;

  const _AccountItem({
    required this.account,
    required this.isSelected,
    required this.query,
    required this.onTap,
  });

  Color _dotColor(String accountName) {
    if (accountName.startsWith('[A]') || accountName.startsWith('Assets')) {
      return const Color(0xFF1A73E8);
    }
    if (accountName.startsWith('[L]') ||
        accountName.startsWith('Liabilities')) {
      return const Color(0xFFFF9500);
    }
    if (accountName.startsWith('[X]') || accountName.startsWith('Expenses')) {
      return const Color(0xFF34C759);
    }
    if (accountName.startsWith('[I]') || accountName.startsWith('Income')) {
      return const Color(0xFF5856D6);
    }
    return const Color(0xFF8E8E93);
  }

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: const BoxDecoration(
          color: Colors.white,
          border: Border(bottom: BorderSide(color: Color(0xFFF2F2F7))),
        ),
        child: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              margin: const EdgeInsets.only(right: 12),
              decoration: BoxDecoration(
                color: _dotColor(account.accountName),
                shape: BoxShape.circle,
              ),
            ),
            Expanded(
              child: _HighlightedText(text: account.displayName, query: query),
            ),
            if (isSelected)
              const Icon(Icons.check, color: Color(0xFF1A73E8), size: 18),
          ],
        ),
      ),
    );
  }
}

class _HighlightedText extends StatelessWidget {
  final String text;
  final String query;

  const _HighlightedText({required this.text, required this.query});

  @override
  Widget build(BuildContext context) {
    if (query.isEmpty) {
      return Text(
        text,
        style: const TextStyle(fontSize: 15, color: Color(0xFF1C1C1E)),
      );
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
        style: const TextStyle(fontSize: 15, color: Color(0xFF1C1C1E)),
        children: spans,
      ),
    );
  }
}
