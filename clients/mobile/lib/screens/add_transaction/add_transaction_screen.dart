import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/account_category.dart';
import '../../core/api_error.dart';
import '../../models/account.dart';
import '../../models/commodity.dart';
import '../../models/posting.dart';
import '../../models/transaction.dart';
import '../../repositories/account_repository.dart';
import '../../repositories/commodity_repository.dart';
import '../../repositories/transaction_repository.dart';
import '../../widgets/currency_picker_sheet.dart';
import '../../widgets/error_banner.dart';
import 'account_picker_screen.dart';

class AddTransactionScreen extends StatefulWidget {
  final AccountRepository accountRepository;
  final CommodityRepository commodityRepository;
  final TransactionRepository transactionRepository;
  final VoidCallback? onOpenSettings;

  const AddTransactionScreen({
    super.key,
    required this.accountRepository,
    required this.commodityRepository,
    required this.transactionRepository,
    this.onOpenSettings,
  });

  @override
  State<AddTransactionScreen> createState() => _AddTransactionScreenState();
}

class _AddTransactionScreenState extends State<AddTransactionScreen> {
  static const _prefKeyLastFrom = 'last_from_account_name';
  static const _prefKeyDefaultCurrency = 'default_currency';

  final _amountController = TextEditingController();
  final _payeeController = TextEditingController();
  final _narrationController = TextEditingController();

  DateTime _date = DateTime.now();
  String _currency = '';
  AccountResource? _fromAccount;
  AccountResource? _toAccount;

  List<AccountResource>? _accounts;
  List<Commodity> _commodities = [];
  SharedPreferences? _prefs;
  bool _saving = false;
  ApiError? _error;

  @override
  void initState() {
    super.initState();
    _loadAccounts();
  }

  Future<void> _loadAccounts() async {
    setState(() {
      _error = null;
    });
    final (accountsResult, commoditiesResult, prefs) = await (
      widget.accountRepository.getAllAccounts(),
      widget.commodityRepository.getAllCommodities(),
      SharedPreferences.getInstance(),
    ).wait;
    _prefs = prefs;
    if (!mounted) return;
    if (accountsResult.error != null) {
      setState(() {
        _error = accountsResult.error;
      });
      return;
    }
    final active = accountsResult.data!.where((a) => a.isActive).toList();
    final lastFromName = prefs.getString(_prefKeyLastFrom);
    final lastFrom = lastFromName != null
        ? active.firstWhereOrNull((a) => a.accountName == lastFromName)
        : null;
    final commodities = commoditiesResult.data ?? [];
    final defaultCurrency = prefs.getString(_prefKeyDefaultCurrency);
    final currency =
        defaultCurrency ??
        (commodities.isNotEmpty ? commodities.first.symbol : 'CHF');
    setState(() {
      _accounts = active;
      _commodities = commodities;
      _currency = currency;
      _fromAccount = lastFrom;
    });
  }

  Future<void> _pickAccount({required bool isFrom}) async {
    if (_accounts == null) return;
    final result = await Navigator.push<AccountResource>(
      context,
      MaterialPageRoute(
        builder: (_) => AccountPickerScreen(
          accounts: _accounts!,
          selected: isFrom ? _fromAccount : _toAccount,
        ),
      ),
    );
    if (result != null) {
      setState(() {
        if (isFrom) {
          _fromAccount = result;
        } else {
          _toAccount = result;
        }
      });
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2000),
      lastDate: DateTime.now().add(const Duration(days: 1)),
      builder: (context, child) => Theme(
        data: Theme.of(context).copyWith(
          colorScheme: const ColorScheme.light(primary: Color(0xFF1A73E8)),
        ),
        child: child!,
      ),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _submit() async {
    final amountText = _amountController.text.trim();
    if (amountText.isEmpty || _fromAccount == null || _toAccount == null) {
      setState(
        () => _error = const ValidationError(
          'Amount, From, and To are required.',
        ),
      );
      return;
    }
    final amount = double.tryParse(amountText);
    if (amount == null || amount <= 0) {
      setState(
        () => _error = const ValidationError('Enter a valid positive amount.'),
      );
      return;
    }
    final amountStr = amount.toStringAsFixed(2);
    final payeeText = _payeeController.text.trim();
    final narrationText = _narrationController.text.trim();
    final tx = TransactionCreate(
      transactionDate: DateFormat('yyyy-MM-dd').format(_date),
      payee: payeeText.isEmpty ? null : payeeText,
      narration: narrationText.isEmpty ? null : narrationText,
      postings: [
        PostingPayload(
          account: _fromAccount!.name,
          units: MoneyValue(amount: '-$amountStr', symbol: _currency),
        ),
        PostingPayload(
          account: _toAccount!.name,
          units: MoneyValue(amount: amountStr, symbol: _currency),
        ),
      ],
    );

    setState(() {
      _saving = true;
      _error = null;
    });
    final result = await widget.transactionRepository.createTransaction(tx);
    if (!mounted) return;

    if (result.error != null) {
      setState(() {
        _saving = false;
        _error = result.error;
      });
      return;
    }

    _prefs!.setString(_prefKeyLastFrom, _fromAccount!.accountName);

    setState(() {
      _saving = false;
      _amountController.clear();
      _payeeController.clear();
      _narrationController.clear();
      _date = DateTime.now();
      _toAccount = null;
    });

    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Transaction saved'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  @override
  void dispose() {
    _amountController.dispose();
    _payeeController.dispose();
    _narrationController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF2F2F7),
      appBar: AppBar(
        title: const Text('New Transaction'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1C1C1E),
        elevation: 0,
        bottom: _saving
            ? const PreferredSize(
                preferredSize: Size.fromHeight(3),
                child: LinearProgressIndicator(
                  backgroundColor: Color(0xFFE5E5EA),
                  color: Color(0xFF1A73E8),
                ),
              )
            : PreferredSize(
                preferredSize: const Size.fromHeight(1),
                child: Container(height: 1, color: const Color(0xFFE5E5EA)),
              ),
      ),
      body: Column(
        children: [
          if (_error != null)
            ErrorBanner(
              error: _error!,
              onRetry: _error is NetworkError ? _loadAccounts : null,
              onSettings: widget.onOpenSettings,
            ),
          Expanded(
            child: ListView(
              children: [
                _AmountHero(
                  controller: _amountController,
                  currency: _currency,
                  date: _date,
                  onDateTap: _pickDate,
                  onCurrencyTap: _pickCurrency,
                ),
                const SizedBox(height: 16),
                _FlowCard(
                  fromAccount: _fromAccount,
                  toAccount: _toAccount,
                  loading: _accounts == null && _error == null,
                  onFromTap: () => _pickAccount(isFrom: true),
                  onToTap: () => _pickAccount(isFrom: false),
                  payeeController: _payeeController,
                  narrationController: _narrationController,
                ),
                const SizedBox(height: 20),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: ElevatedButton(
                    onPressed: _saving ? null : _submit,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF1A73E8),
                      foregroundColor: Colors.white,
                      disabledBackgroundColor: const Color(0xFFB0CCEF),
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                      elevation: 0,
                    ),
                    child: const Text(
                      'Add Transaction',
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 32),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _pickCurrency() async {
    final v = await showModalBottomSheet<String>(
      context: context,
      builder: (_) =>
          CurrencyPickerSheet(commodities: _commodities, selected: _currency),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
    );
    if (v != null && mounted) setState(() => _currency = v);
  }
}

// ---------------------------------------------------------------------------

class _AmountHero extends StatelessWidget {
  final TextEditingController controller;
  final String currency;
  final DateTime date;
  final VoidCallback onDateTap;
  final VoidCallback onCurrencyTap;

  const _AmountHero({
    required this.controller,
    required this.currency,
    required this.date,
    required this.onDateTap,
    required this.onCurrencyTap,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
      child: Column(
        children: [
          GestureDetector(
            onTap: onCurrencyTap,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              decoration: BoxDecoration(
                color: const Color(0xFFEBF2FE),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    currency.isEmpty ? '…' : currency,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF1A73E8),
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Icon(
                    Icons.keyboard_arrow_down,
                    size: 16,
                    color: Color(0xFF1A73E8),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: controller,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'^\d*\.?\d{0,2}')),
            ],
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 52,
              fontWeight: FontWeight.w300,
              color: Color(0xFF1C1C1E),
              letterSpacing: -2,
            ),
            decoration: const InputDecoration(
              border: InputBorder.none,
              hintText: '0.00',
              hintStyle: TextStyle(
                fontSize: 52,
                fontWeight: FontWeight.w300,
                color: Color(0xFFC7C7CC),
                letterSpacing: -2,
              ),
            ),
          ),
          GestureDetector(
            onTap: onDateTap,
            child: Text(
              DateFormat('EEEE, MMMM d').format(date),
              style: const TextStyle(fontSize: 13, color: Color(0xFF8E8E93)),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _FlowCard extends StatelessWidget {
  final AccountResource? fromAccount;
  final AccountResource? toAccount;
  final bool loading;
  final VoidCallback onFromTap;
  final VoidCallback onToTap;
  final TextEditingController payeeController;
  final TextEditingController narrationController;

  const _FlowCard({
    required this.fromAccount,
    required this.toAccount,
    required this.loading,
    required this.onFromTap,
    required this.onToTap,
    required this.payeeController,
    required this.narrationController,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.07),
            blurRadius: 3,
            offset: const Offset(0, 1),
          ),
        ],
      ),
      child: Column(
        children: [
          _AccountRow(
            label: 'FROM',
            account: fromAccount,
            loading: loading,
            onTap: onFromTap,
          ),
          Padding(
            padding: const EdgeInsets.only(left: 30),
            child: Row(
              children: [
                SizedBox(
                  width: 36,
                  child: Column(
                    children: [
                      Container(
                        width: 1.5,
                        height: 16,
                        color: const Color(0xFFE5E5EA),
                      ),
                      const Icon(
                        Icons.arrow_downward,
                        size: 14,
                        color: Color(0xFFC7C7CC),
                      ),
                    ],
                  ),
                ),
                const Expanded(
                  child: Divider(height: 1, color: Color(0xFFF2F2F7)),
                ),
              ],
            ),
          ),
          _AccountRow(
            label: 'TO',
            account: toAccount,
            loading: loading,
            onTap: onToTap,
          ),
          _LabeledTextField(
            label: 'Payee',
            controller: payeeController,
            hintText: 'Migros, Manor…',
          ),
          _LabeledTextField(
            label: 'Narration',
            controller: narrationController,
            hintText: 'Weekly groceries…',
          ),
        ],
      ),
    );
  }
}

class _LabeledTextField extends StatelessWidget {
  final String label;
  final TextEditingController controller;
  final String hintText;

  const _LabeledTextField({
    required this.label,
    required this.controller,
    required this.hintText,
  });

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: Color(0xFFF2F2F7))),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            SizedBox(
              width: 80,
              child: Text(
                label,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            Expanded(
              child: TextField(
                controller: controller,
                decoration: InputDecoration(
                  border: InputBorder.none,
                  hintText: hintText,
                  hintStyle: const TextStyle(color: Color(0xFFC7C7CC)),
                  isDense: true,
                  contentPadding: EdgeInsets.zero,
                ),
                style: const TextStyle(fontSize: 15),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AccountRow extends StatelessWidget {
  final String label;
  final AccountResource? account;
  final bool loading;
  final VoidCallback onTap;

  const _AccountRow({
    required this.label,
    required this.account,
    required this.loading,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = account != null
        ? themeForAccount(account!.accountName)
        : noAccountTheme;
    return InkWell(
      onTap: loading ? null : onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: theme.lightBg,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(theme.icon, color: theme.color, size: 20),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF8E8E93),
                      letterSpacing: 0.5,
                    ),
                  ),
                  const SizedBox(height: 2),
                  if (loading)
                    const SizedBox(
                      height: 14,
                      width: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  else
                    Text(
                      account?.displayName ?? 'Select account…',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w500,
                        color: account != null
                            ? const Color(0xFF1C1C1E)
                            : const Color(0xFFC7C7CC),
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: Color(0xFFC7C7CC), size: 20),
          ],
        ),
      ),
    );
  }
}
