import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../core/account_hierarchy.dart';
import '../../models/account.dart';
import '../../models/commodity.dart';
import '../../repositories/commodity_repository.dart';
import '../../repositories/transaction_repository.dart';
import '../add_transaction/account_picker_screen.dart';
import 'transaction_filter.dart';

Future<TransactionFilter?> showTransactionFilterSheet(
  BuildContext context, {
  required List<AccountResource> accounts,
  required TransactionFilter current,
  required TransactionRepository transactionRepository,
  required CommodityRepository commodityRepository,
}) {
  return showModalBottomSheet<TransactionFilter>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => TransactionFilterSheet(
      accounts: accounts,
      initial: current,
      transactionRepository: transactionRepository,
      commodityRepository: commodityRepository,
    ),
  );
}

class TransactionFilterSheet extends StatefulWidget {
  final List<AccountResource> accounts;
  final TransactionFilter initial;
  final TransactionRepository transactionRepository;
  final CommodityRepository commodityRepository;

  const TransactionFilterSheet({
    super.key,
    required this.accounts,
    required this.initial,
    required this.transactionRepository,
    required this.commodityRepository,
  });

  @override
  State<TransactionFilterSheet> createState() => _TransactionFilterSheetState();
}

class _TransactionFilterSheetState extends State<TransactionFilterSheet> {
  late TransactionFilter _draft;
  late List<AccountResource> _pickerAccounts;
  List<int> _years = [];
  bool _yearsLoading = true;
  final ScrollController _yearsScrollController = ScrollController();
  List<Commodity> _commodities = [];
  bool _commoditiesLoading = true;

  @override
  void initState() {
    super.initState();
    _draft = widget.initial;
    _pickerAccounts = buildPickerAccounts(widget.accounts);
    _loadYears();
    _loadCommodities();
  }

  @override
  void dispose() {
    _yearsScrollController.dispose();
    super.dispose();
  }

  Future<void> _loadCommodities() async {
    final result = await widget.commodityRepository.getAllCommodities();
    if (!mounted) return;
    setState(() {
      _commoditiesLoading = false;
      if (result.data != null) _commodities = result.data!;
    });
  }

  Future<void> _loadYears() async {
    final result = await widget.transactionRepository.getYearRange();
    if (!mounted) return;
    setState(() {
      _yearsLoading = false;
      if (result.data != null) {
        final (oldest, newest) = result.data!;
        _years = List.generate(newest - oldest + 1, (i) => oldest + i);
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _years.isEmpty) return;
      if (!_yearsScrollController.hasClients) return;
      final currentYear = DateTime.now().year;
      final idx = _years.indexOf(currentYear);
      if (idx < 0) return;
      // Each pill: ~14+~30+14 px content + 8 px gap ≈ 66 px stride.
      const pillStride = 66.0;
      final pillCenter = idx * pillStride + pillStride / 2;
      final offset =
          (pillCenter - _yearsScrollController.position.viewportDimension / 2)
              .clamp(
                _yearsScrollController.position.minScrollExtent,
                _yearsScrollController.position.maxScrollExtent,
              );
      _yearsScrollController.jumpTo(offset);
    });
  }

  int? get _draftFromYear {
    final d = _draft.fromDate;
    if (d == null) return null;
    return (d.month == 1 && d.day == 1) ? d.year : null;
  }

  int? get _draftToYear {
    final d = _draft.toDate;
    if (d == null) return null;
    return (d.month == 12 && d.day == 31) ? d.year : null;
  }

  void _onYearTap(int year) {
    final from = _draftFromYear;
    final to = _draftToYear;

    int? newFrom, newTo;
    if (from == null) {
      newFrom = newTo = year;
    } else if (year == from && year == to) {
      newFrom = newTo = null;
    } else if (year == from) {
      final nextIdx = _years.indexOf(year) + 1;
      final next = nextIdx < _years.length ? _years[nextIdx] : null;
      if (next != null && next <= to!) {
        newFrom = next;
        newTo = to;
      } else {
        newFrom = newTo = null;
      }
    } else if (year == to) {
      final prevIdx = _years.indexOf(year) - 1;
      final prev = prevIdx >= 0 ? _years[prevIdx] : null;
      if (prev != null && prev >= from) {
        newFrom = from;
        newTo = prev;
      } else {
        newFrom = newTo = null;
      }
    } else if (year < from || year > to!) {
      newFrom = year < from ? year : from;
      newTo = year > to! ? year : to;
    } else {
      newFrom = newTo = year;
    }

    setState(() {
      _draft = _draft.copyWith(
        fromDate: newFrom != null ? DateTime(newFrom) : null,
        toDate: newTo != null ? DateTime(newTo, 12, 31) : null,
      );
    });
  }

  Future<void> _pickFromDate() async {
    final picked = await _showMonthYearPicker(
      context,
      initial: _draft.fromDate,
      years: _years,
      isFrom: true,
    );
    if (picked != null && mounted) {
      setState(() => _draft = _draft.copyWith(fromDate: picked));
    }
  }

  Future<void> _pickToDate() async {
    final picked = await _showMonthYearPicker(
      context,
      initial: _draft.toDate,
      years: _years,
      isFrom: false,
    );
    if (picked != null && mounted) {
      setState(() => _draft = _draft.copyWith(toDate: picked));
    }
  }

  Future<void> _pickAccount() async {
    final result = await Navigator.push<AccountResource>(
      context,
      MaterialPageRoute(
        builder: (_) => AccountPickerScreen(
          accounts: _pickerAccounts,
          selected: _draft.account,
        ),
      ),
    );
    if (result != null && mounted) {
      setState(() => _draft = _draft.copyWith(account: result));
    }
  }

  @override
  Widget build(BuildContext context) {
    final fromYear = _draftFromYear;
    final toYear = _draftToYear;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                children: [
                  TextButton(
                    onPressed: () =>
                        Navigator.pop(context, const TransactionFilter()),
                    child: const Text(
                      'Reset',
                      style: TextStyle(color: Color(0xFF1A73E8)),
                    ),
                  ),
                  const Expanded(
                    child: Text(
                      'Filter',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF1C1C1E),
                      ),
                    ),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(context, _draft),
                    child: const Text(
                      'Apply',
                      style: TextStyle(color: Color(0xFF1A73E8)),
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0xFFE5E5EA)),

            // Last import toggle
            InkWell(
              onTap: () => setState(() {
                _draft = _draft.copyWith(
                  lastImportOnly: !_draft.lastImportOnly,
                );
              }),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    const Text(
                      'Last import',
                      style: TextStyle(fontSize: 15, color: Color(0xFF1C1C1E)),
                    ),
                    const Spacer(),
                    Switch.adaptive(
                      value: _draft.lastImportOnly,
                      onChanged: (v) => setState(
                        () => _draft = _draft.copyWith(lastImportOnly: v),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const Divider(height: 1, color: Color(0xFFE5E5EA)),

            // Account section
            InkWell(
              onTap: _pickAccount,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 14,
                ),
                child: Row(
                  children: [
                    const Text(
                      'Account',
                      style: TextStyle(fontSize: 15, color: Color(0xFF1C1C1E)),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _draft.accountLabel ?? 'Any account',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.end,
                        style: const TextStyle(
                          fontSize: 15,
                          color: Color(0xFF8E8E93),
                        ),
                      ),
                    ),
                    if (_draft.account != null)
                      GestureDetector(
                        onTap: () => setState(
                          () => _draft = _draft.copyWith(account: null),
                        ),
                        child: const Padding(
                          padding: EdgeInsets.only(left: 8),
                          child: Icon(
                            Icons.close,
                            size: 16,
                            color: Color(0xFF8E8E93),
                          ),
                        ),
                      )
                    else
                      const Padding(
                        padding: EdgeInsets.only(left: 8),
                        child: Icon(
                          Icons.chevron_right,
                          size: 20,
                          color: Color(0xFF8E8E93),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const Divider(height: 1, indent: 16, color: Color(0xFFE5E5EA)),

            // Commodity section
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Commodity',
                    style: TextStyle(fontSize: 15, color: Color(0xFF1C1C1E)),
                  ),
                  const SizedBox(height: 8),
                  _commoditiesLoading
                      ? const SizedBox(
                          height: 32,
                          child: Center(
                            child: SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          ),
                        )
                      : Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            _FilterPill(
                              label: 'Any commodity',
                              selected: _draft.currency == null,
                              onTap: () => setState(
                                () => _draft = _draft.copyWith(currency: null),
                              ),
                            ),
                            for (final commodity in _commodities)
                              _FilterPill(
                                label: commodity.symbol,
                                selected: _draft.currency == commodity.symbol,
                                onTap: () => setState(
                                  () => _draft = _draft.copyWith(
                                    currency: commodity.symbol,
                                  ),
                                ),
                              ),
                          ],
                        ),
                ],
              ),
            ),
            const Divider(height: 1, indent: 16, color: Color(0xFFE5E5EA)),

            // Year pills
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: _yearsLoading
                  ? const SizedBox(
                      height: 32,
                      child: Center(
                        child: SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      ),
                    )
                  : SingleChildScrollView(
                      controller: _yearsScrollController,
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: _years.map((year) {
                          final selected =
                              fromYear != null &&
                              year >= fromYear &&
                              year <= (toYear ?? fromYear);
                          return Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: _FilterPill(
                              label: '$year',
                              selected: selected,
                              onTap: () => _onYearTap(year),
                            ),
                          );
                        }).toList(),
                      ),
                    ),
            ),

            // From / To rows
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              child: Row(
                children: [
                  Expanded(
                    child: _DateRow(
                      label: 'From',
                      date: _draft.fromDate,
                      onTap: _pickFromDate,
                      onClear: _draft.fromDate != null
                          ? () => setState(
                              () => _draft = _draft.copyWith(fromDate: null),
                            )
                          : null,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _DateRow(
                      label: 'To',
                      date: _draft.toDate,
                      onTap: _pickToDate,
                      onClear: _draft.toDate != null
                          ? () => setState(
                              () => _draft = _draft.copyWith(toDate: null),
                            )
                          : null,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}

/// Selectable pill shared by the year and commodity rows.
class _FilterPill extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _FilterPill({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? const Color(0xFF1A73E8) : Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected ? const Color(0xFF1A73E8) : const Color(0xFFDADCE0),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
            color: selected ? Colors.white : const Color(0xFF3C4043),
          ),
        ),
      ),
    );
  }
}

class _DateRow extends StatelessWidget {
  final String label;
  final DateTime? date;
  final VoidCallback onTap;
  final VoidCallback? onClear;

  static final _fmt = DateFormat('MMM yyyy');

  const _DateRow({
    required this.label,
    required this.date,
    required this.onTap,
    this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          border: Border.all(color: const Color(0xFFDADCE0)),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label.toUpperCase(),
              style: const TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.5,
                color: Color(0xFF80868B),
              ),
            ),
            const SizedBox(height: 2),
            Row(
              children: [
                Expanded(
                  child: Text(
                    date != null ? _fmt.format(date!) : 'Any',
                    style: TextStyle(
                      fontSize: 13,
                      color: date != null
                          ? const Color(0xFF1C1C1E)
                          : const Color(0xFF8E8E93),
                    ),
                  ),
                ),
                if (onClear != null)
                  GestureDetector(
                    onTap: onClear,
                    child: const Icon(
                      Icons.close,
                      size: 14,
                      color: Color(0xFF8E8E93),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

Future<DateTime?> _showMonthYearPicker(
  BuildContext context, {
  required DateTime? initial,
  required List<int> years,
  required bool isFrom,
}) {
  return showModalBottomSheet<DateTime>(
    context: context,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) =>
        _MonthYearPicker(initial: initial, years: years, isFrom: isFrom),
  );
}

class _MonthYearPicker extends StatefulWidget {
  final DateTime? initial;
  final List<int> years;
  final bool isFrom;

  const _MonthYearPicker({
    required this.initial,
    required this.years,
    required this.isFrom,
  });

  @override
  State<_MonthYearPicker> createState() => _MonthYearPickerState();
}

class _MonthYearPickerState extends State<_MonthYearPicker> {
  late FixedExtentScrollController _monthCtrl;
  late FixedExtentScrollController _yearCtrl;
  late int _selectedMonth;
  late int _selectedYear;

  static const _months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _selectedMonth = (widget.initial?.month ?? now.month) - 1; // 0-indexed
    _selectedYear = widget.initial?.year ?? now.year;

    final yearIdx = widget.years.isEmpty
        ? 0
        : widget.years.indexOf(_selectedYear).clamp(0, widget.years.length - 1);

    _monthCtrl = FixedExtentScrollController(initialItem: _selectedMonth);
    _yearCtrl = FixedExtentScrollController(initialItem: yearIdx);
  }

  @override
  void dispose() {
    _monthCtrl.dispose();
    _yearCtrl.dispose();
    super.dispose();
  }

  void _onDone() {
    final month = _selectedMonth + 1;
    final year = _selectedYear;
    final DateTime result;
    if (widget.isFrom) {
      result = DateTime(year, month);
    } else {
      result = DateTime(year, month + 1, 0); // last day of month
    }
    Navigator.pop(context, result);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Header
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(
              children: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text(
                    'Cancel',
                    style: TextStyle(color: Color(0xFF1A73E8)),
                  ),
                ),
                const Spacer(),
                TextButton(
                  onPressed: _onDone,
                  child: const Text(
                    'Done',
                    style: TextStyle(
                      color: Color(0xFF1A73E8),
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 1, color: Color(0xFFE5E5EA)),
          SizedBox(
            height: 200,
            child: Row(
              children: [
                // Month wheel
                Expanded(
                  flex: 3,
                  child: ListWheelScrollView.useDelegate(
                    controller: _monthCtrl,
                    itemExtent: 40,
                    diameterRatio: 2.5,
                    physics: const FixedExtentScrollPhysics(),
                    onSelectedItemChanged: (i) =>
                        setState(() => _selectedMonth = i),
                    childDelegate: ListWheelChildBuilderDelegate(
                      childCount: 12,
                      builder: (_, i) => Center(
                        child: Text(
                          _months[i],
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: _selectedMonth == i
                                ? FontWeight.w600
                                : FontWeight.normal,
                            color: _selectedMonth == i
                                ? const Color(0xFF1C1C1E)
                                : const Color(0xFF8E8E93),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                // Year wheel
                Expanded(
                  flex: 2,
                  child: widget.years.isEmpty
                      ? const Center(
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : ListWheelScrollView.useDelegate(
                          controller: _yearCtrl,
                          itemExtent: 40,
                          diameterRatio: 2.5,
                          physics: const FixedExtentScrollPhysics(),
                          onSelectedItemChanged: (i) =>
                              setState(() => _selectedYear = widget.years[i]),
                          childDelegate: ListWheelChildBuilderDelegate(
                            childCount: widget.years.length,
                            builder: (_, i) => Center(
                              child: Text(
                                '${widget.years[i]}',
                                style: TextStyle(
                                  fontSize: 18,
                                  fontWeight: widget.years[i] == _selectedYear
                                      ? FontWeight.w600
                                      : FontWeight.normal,
                                  color: widget.years[i] == _selectedYear
                                      ? const Color(0xFF1C1C1E)
                                      : const Color(0xFF8E8E93),
                                ),
                              ),
                            ),
                          ),
                        ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
