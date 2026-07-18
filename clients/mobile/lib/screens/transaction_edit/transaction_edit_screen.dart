import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import '../../core/account_category.dart';
import '../../core/api_error.dart';
import '../../core/generation_guard.dart';
import '../../models/account.dart';
import '../../models/commodity.dart';
import '../../models/doctor_issue.dart';
import '../../models/posting.dart';
import '../../models/transaction.dart';
import '../../repositories/account_repository.dart';
import '../../repositories/commodity_repository.dart';
import '../../repositories/transaction_repository.dart';
import '../../core/amount_format.dart';
import '../../widgets/currency_picker_sheet.dart';
import '../../widgets/error_banner.dart';
import '../../widgets/labeled_text_field.dart';
import '../add_transaction/account_picker_screen.dart';

// Mutable editing state for one posting row.
class _EditablePosting {
  AccountResource? account;
  final TextEditingController amountController;
  final FocusNode amountFocusNode;
  String currency;
  // Non-null only when the original posting had cost/price set.
  final TextEditingController? costAmountController;
  final FocusNode? costFocusNode;
  String? costCurrency;
  final TextEditingController? priceAmountController;
  final FocusNode? priceFocusNode;
  String? priceCurrency;

  _EditablePosting({
    this.account,
    required String initialAmount,
    required this.currency,
    MoneyValue? cost,
    MoneyValue? price,
  }) : amountController = TextEditingController(
         text: formatDisplayAmount(initialAmount),
       ),
       amountFocusNode = FocusNode(),
       costAmountController = cost != null
           ? TextEditingController(text: formatDisplayAmount(cost.amount))
           : null,
       costFocusNode = cost != null ? FocusNode() : null,
       costCurrency = cost?.symbol,
       priceAmountController = price != null
           ? TextEditingController(text: formatDisplayAmount(price.amount))
           : null,
       priceFocusNode = price != null ? FocusNode() : null,
       priceCurrency = price?.symbol {
    wireAmountFocus(amountFocusNode, amountController);
    if (costFocusNode != null) {
      wireAmountFocus(costFocusNode!, costAmountController!);
    }
    if (priceFocusNode != null) {
      wireAmountFocus(priceFocusNode!, priceAmountController!);
    }
  }

  void dispose() {
    amountController.dispose();
    amountFocusNode.dispose();
    costAmountController?.dispose();
    costFocusNode?.dispose();
    priceAmountController?.dispose();
    priceFocusNode?.dispose();
  }
}

// Popped by TransactionEditScreen on a successful save: the fresh resource
// (converted, when defaultCurrency was given — see below), plus any error
// from the follow-up GET that fetched it (the PATCH itself already
// succeeded by then, so this doesn't block the pop; the caller decides how
// to surface it).
typedef TransactionEditResult = (TransactionResource, ApiError?);

class TransactionEditScreen extends StatefulWidget {
  final TransactionResource transaction;
  final TransactionRepository transactionRepository;
  final AccountRepository accountRepository;
  final CommodityRepository commodityRepository;
  // Only used for the post-save GET (see _save) so the caller gets back an
  // already-converted resource instead of having to re-fetch it itself.
  // The edit form always shows/edits raw, unconverted values — this never
  // reaches form state.
  final String? defaultCurrency;

  const TransactionEditScreen({
    super.key,
    required this.transaction,
    required this.transactionRepository,
    required this.accountRepository,
    required this.commodityRepository,
    this.defaultCurrency,
  });

  @override
  State<TransactionEditScreen> createState() => _TransactionEditScreenState();
}

class _TransactionEditScreenState extends State<TransactionEditScreen> {
  final _payeeController = TextEditingController();
  final _narrationController = TextEditingController();

  DateTime _date = DateTime.now();
  List<_EditablePosting> _postings = [];

  List<AccountResource>? _accounts;
  List<Commodity> _commodities = [];

  bool _saving = false;
  ApiError? _error;

  // Server-computed preview (POST /transactions:normalize), refreshed on a
  // debounce after each edit — see _scheduleNormalizeCheck. Never re-derive
  // "weight" (cost/price-adjusted balance) here: the server already knows
  // that rule and this keeps the preview identical to what a save would
  // report. Parsed once when a response lands (not re-parsed on every
  // read) — a transaction can be unbalanced in more than one currency at
  // once, so this holds every transaction_unbalanced issue, not just the
  // largest.
  List<({String symbol, double amount})> _imbalances = const [];
  Timer? _normalizeDebounce;
  // A response is only applied if it's still the most recent check
  // requested — otherwise a slow, superseded response could land after a
  // faster later one and silently show stale results.
  final _normalizeGuard = GenerationGuard();

  @override
  void initState() {
    super.initState();
    final tx = widget.transaction;
    _date = DateTime.tryParse(tx.transactionDate) ?? DateTime.now();
    _payeeController.text = tx.payee ?? '';
    _narrationController.text = tx.narration ?? '';
    _postings = tx.postings.map((p) {
      final fakeAccount = AccountResource(
        name: p.account,
        accountName: p.accountName ?? p.account,
        effectiveStartDate: '2000-01-01',
      );
      final posting = _EditablePosting(
        account: fakeAccount,
        initialAmount: p.units.amount,
        currency: p.units.symbol,
        cost: p.cost,
        price: p.price,
      );
      _wireNormalizeTrigger(posting);
      return posting;
    }).toList();
    _loadAccountsAndCommodities();
    // Runs once on open (even with no edits yet) so a transaction that was
    // ALREADY unbalanced before opening shows that immediately, not only
    // after the user starts typing.
    _scheduleNormalizeCheck();
  }

  // Compares the parsed numeric value, not raw text, before rescheduling:
  // TextEditingController notifies on any value change, including ones
  // that don't change what the field means — wireAmountFocus's own
  // reformatting (see core/amount_format.dart: strip/add commas, pad
  // decimals on focus change) and pure cursor/selection moves (e.g. simply
  // tapping into a field) both fire it with the number itself unchanged. A
  // flag marking "this notification came from a reformat" was tried and
  // reverted — it doesn't cover the cursor-move case, so it's a narrower,
  // less correct filter than comparing the actual value.
  void _wireNormalizeTrigger(_EditablePosting p) {
    _wireValueTrigger(p.amountController);
    if (p.costAmountController != null) {
      _wireValueTrigger(p.costAmountController!);
    }
    if (p.priceAmountController != null) {
      _wireValueTrigger(p.priceAmountController!);
    }
  }

  void _wireValueTrigger(TextEditingController controller) {
    double? lastValue = double.tryParse(rawEditAmount(controller.text));
    controller.addListener(() {
      final value = double.tryParse(rawEditAmount(controller.text));
      if (value == lastValue) return;
      lastValue = value;
      _scheduleNormalizeCheck();
    });
  }

  Future<void> _loadAccountsAndCommodities() async {
    final (accountsResult, commoditiesResult) = await (
      widget.accountRepository.getAllAccounts(),
      widget.commodityRepository.getAllCommodities(),
    ).wait;
    if (!mounted) return;
    if (accountsResult.error != null) {
      setState(() => _error = accountsResult.error);
      return;
    }
    setState(() {
      _accounts = accountsResult.data!.where((a) => a.isActive).toList();
      _commodities = commoditiesResult.data ?? [];
    });
  }

  @override
  void dispose() {
    _normalizeDebounce?.cancel();
    _payeeController.dispose();
    _narrationController.dispose();
    for (final p in _postings) {
      p.dispose();
    }
    super.dispose();
  }

  bool get _allPostingsValid => _postings.every(
    (p) =>
        p.account != null &&
        double.tryParse(rawEditAmount(p.amountController.text.trim())) != null,
  );

  PostingPayload _toPostingPayload(_EditablePosting p) {
    final hasCost = p.costAmountController != null && p.costCurrency != null;
    final hasPrice = p.priceAmountController != null && p.priceCurrency != null;
    return PostingPayload(
      account: p.account!.name,
      units: MoneyValue(
        amount: rawEditAmount(p.amountController.text.trim()),
        symbol: p.currency,
      ),
      cost: hasCost
          ? MoneyValue(
              amount: rawEditAmount(p.costAmountController!.text.trim()),
              symbol: p.costCurrency!,
            )
          : null,
      price: hasPrice
          ? MoneyValue(
              amount: rawEditAmount(p.priceAmountController!.text.trim()),
              symbol: p.priceCurrency!,
            )
          : null,
    );
  }

  // Shared by _save and _runNormalizeCheck so the two never build the
  // transaction payload differently from each other.
  TransactionUpdate _buildUpdate() {
    final payeeText = _payeeController.text.trim();
    final narrationText = _narrationController.text.trim();
    return TransactionUpdate(
      transactionDate: DateFormat('yyyy-MM-dd').format(_date),
      payee: payeeText.isEmpty ? null : payeeText,
      narration: narrationText.isEmpty ? null : narrationText,
      postings: _postings.map(_toPostingPayload).toList(),
    );
  }

  void _scheduleNormalizeCheck() {
    _normalizeDebounce?.cancel();
    _normalizeDebounce = Timer(
      const Duration(milliseconds: 400),
      _runNormalizeCheck,
    );
  }

  Future<void> _runNormalizeCheck() async {
    final generation = _normalizeGuard.start();
    if (!_allPostingsValid) {
      if (mounted) setState(() => _imbalances = const []);
      return;
    }
    final result = await widget.transactionRepository.normalizeTransaction(
      _buildUpdate(),
    );
    // A newer check has started since this one was sent — e.g. this one was
    // slow and a later edit's check already finished — so this response no
    // longer reflects the current form and must not overwrite it.
    if (!mounted || !_normalizeGuard.isCurrent(generation)) return;
    // A failed/offline check must not blank out the last known warning —
    // it's a non-blocking hint, and flashing it away on a transient
    // network hiccup would be more disruptive than a stale value.
    if (result.error != null) return;
    setState(() => _imbalances = _parseImbalances(result.data!));
  }

  // Every transaction_unbalanced issue from a normalize response — a
  // transaction can be unbalanced in more than one currency at once, and
  // hiding all but the largest would hide a real problem.
  List<({String symbol, double amount})> _parseImbalances(
    List<DoctorIssue> issues,
  ) {
    final result = <({String symbol, double amount})>[];
    for (final issue in issues) {
      if (issue.code != DoctorIssue.transactionUnbalanced) continue;
      final symbol = issue.details['symbol'];
      final amount = double.tryParse(issue.details['residual_amount'] ?? '');
      if (symbol == null || amount == null) continue;
      result.add((symbol: symbol, amount: amount));
    }
    return result;
  }

  Future<void> _pickAccount(int index) async {
    if (_accounts == null) return;
    final result = await Navigator.push<AccountResource>(
      context,
      MaterialPageRoute(
        builder: (_) => AccountPickerScreen(
          accounts: _accounts!,
          selected: _postings[index].account,
        ),
      ),
    );
    if (result != null && mounted) {
      setState(() => _postings[index].account = result);
      _scheduleNormalizeCheck();
    }
  }

  Future<void> _pickCurrencyFor(
    int index, {
    String? title,
    required String? Function(_EditablePosting) get,
    required void Function(_EditablePosting, String) set,
  }) async {
    final v = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => CurrencyPickerSheet(
        commodities: _commodities,
        selected: get(_postings[index]),
        title: title ?? 'Currency',
      ),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
    );
    if (v != null && mounted) {
      setState(() => set(_postings[index], v));
      _scheduleNormalizeCheck();
    }
  }

  Future<void> _pickCurrency(int index) => _pickCurrencyFor(
    index,
    get: (p) => p.currency,
    set: (p, v) => p.currency = v,
  );

  Future<void> _pickCostCurrency(int index) => _pickCurrencyFor(
    index,
    title: 'Cost Currency',
    get: (p) => p.costCurrency,
    set: (p, v) => p.costCurrency = v,
  );

  Future<void> _pickPriceCurrency(int index) => _pickCurrencyFor(
    index,
    title: 'Price Currency',
    get: (p) => p.priceCurrency,
    set: (p, v) => p.priceCurrency = v,
  );

  Future<void> _addPosting() async {
    if (_accounts == null) return;
    // Can only prefill one new row, so pick the largest of possibly several
    // imbalances as the best single guess. This is a best-effort read of
    // the last successful check — it can be briefly stale (debounce +
    // network latency behind the very latest keystroke), which is fine
    // for a prefill the user can freely edit before saving.
    final imbalance = _imbalances.isEmpty
        ? null
        : _imbalances.reduce(
            (a, b) => a.amount.abs() >= b.amount.abs() ? a : b,
          );
    final prefillAmount = imbalance != null
        ? (-imbalance.amount).toStringAsFixed(2)
        : '';
    final prefillCurrency =
        imbalance?.symbol ??
        (_postings.isNotEmpty ? _postings.first.currency : 'CHF');

    final result = await Navigator.push<AccountResource>(
      context,
      MaterialPageRoute(
        builder: (_) => AccountPickerScreen(accounts: _accounts!),
      ),
    );
    if (result != null && mounted) {
      setState(() {
        final posting = _EditablePosting(
          account: result,
          initialAmount: prefillAmount,
          currency: prefillCurrency,
        );
        _wireNormalizeTrigger(posting);
        _postings.add(posting);
      });
      _scheduleNormalizeCheck();
    }
  }

  void _removePosting(int index) {
    setState(() {
      _postings[index].dispose();
      _postings.removeAt(index);
    });
    _scheduleNormalizeCheck();
  }

  Future<void> _save() async {
    for (final p in _postings) {
      if (p.account == null) {
        setState(
          () => _error = const ValidationError('All postings need an account.'),
        );
        return;
      }
      if (double.tryParse(rawEditAmount(p.amountController.text.trim())) ==
          null) {
        setState(
          () => _error = const ValidationError(
            'All postings need a valid amount.',
          ),
        );
        return;
      }
    }

    final update = _buildUpdate();

    setState(() {
      _saving = true;
      _error = null;
    });

    final updateResult = await widget.transactionRepository.updateTransaction(
      widget.transaction.name,
      update,
    );
    if (!mounted) return;

    if (updateResult.error != null) {
      setState(() {
        _saving = false;
        _error = updateResult.error;
      });
      return;
    }

    // Fetch fresh resource so list row reflects any server-side
    // normalisation — converted, when a default currency is configured, so
    // the caller doesn't need a second round-trip just to get that.
    final getResult = await widget.transactionRepository.getTransaction(
      widget.transaction.name,
      convert: widget.defaultCurrency,
    );
    if (!mounted) return;

    // Use the PATCH response as fallback if the follow-up GET fails; the
    // caller still learns about that failure via the second element.
    Navigator.pop<TransactionEditResult>(context, (
      getResult.data ?? updateResult.data!,
      getResult.error,
    ));
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

  @override
  Widget build(BuildContext context) {
    final imbalances = _imbalances;

    return Scaffold(
      backgroundColor: const Color(0xFFF2F2F7),
      appBar: AppBar(
        title: const Text('Transaction'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1C1C1E),
        elevation: 0,
        actions: [
          TextButton(
            onPressed: _saving ? null : _save,
            child: Text(
              'Save',
              style: TextStyle(
                color: _saving
                    ? const Color(0xFFB0CCEF)
                    : const Color(0xFF1A73E8),
                fontSize: 17,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
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
              onRetry: _error is NetworkError
                  ? _loadAccountsAndCommodities
                  : null,
            ),
          Expanded(
            child: ListView(
              children: [
                const SizedBox(height: 16),
                _HeaderCard(
                  date: _date,
                  payeeController: _payeeController,
                  narrationController: _narrationController,
                  onDateTap: _pickDate,
                ),
                const SizedBox(height: 16),
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 0, 16, 6),
                  child: Text(
                    'POSTINGS',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF8E8E93),
                      letterSpacing: 0.5,
                    ),
                  ),
                ),
                for (int i = 0; i < _postings.length; i++)
                  _PostingEditCard(
                    posting: _postings[i],
                    onAccountTap: () => _pickAccount(i),
                    onCurrencyTap: () => _pickCurrency(i),
                    onCostCurrencyTap: () => _pickCostCurrency(i),
                    onPriceCurrencyTap: () => _pickPriceCurrency(i),
                    onDelete: _postings.length > 1
                        ? () => _removePosting(i)
                        : null,
                  ),
                _AddPostingRow(onTap: _accounts == null ? null : _addPosting),
                if (imbalances.isNotEmpty)
                  _ImbalanceWarning(imbalances: imbalances),
                const SizedBox(height: 32),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _HeaderCard extends StatelessWidget {
  static final _dateFormat = DateFormat('EEEE, MMMM d');

  final DateTime date;
  final TextEditingController payeeController;
  final TextEditingController narrationController;
  final VoidCallback onDateTap;

  const _HeaderCard({
    required this.date,
    required this.payeeController,
    required this.narrationController,
    required this.onDateTap,
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
          InkWell(
            onTap: onDateTap,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Row(
                children: [
                  const SizedBox(
                    width: 80,
                    child: Text(
                      'Date',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      _dateFormat.format(date),
                      style: const TextStyle(
                        fontSize: 15,
                        color: Color(0xFF1A73E8),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          LabeledTextField(
            label: 'Payee',
            controller: payeeController,
            hintText: 'Migros, Manor…',
          ),
          LabeledTextField(
            label: 'Narration',
            controller: narrationController,
            hintText: 'Weekly groceries…',
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _PostingEditCard extends StatelessWidget {
  final _EditablePosting posting;
  final VoidCallback onAccountTap;
  final VoidCallback onCurrencyTap;
  final VoidCallback onCostCurrencyTap;
  final VoidCallback onPriceCurrencyTap;
  final VoidCallback? onDelete;

  const _PostingEditCard({
    required this.posting,
    required this.onAccountTap,
    required this.onCurrencyTap,
    required this.onCostCurrencyTap,
    required this.onPriceCurrencyTap,
    this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final account = posting.account;
    final theme = themeForAccount(account?.accountName);

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
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
          InkWell(
            onTap: onAccountTap,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
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
                    child: Text(
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
                  ),
                  const Icon(
                    Icons.chevron_right,
                    color: Color(0xFFC7C7CC),
                    size: 20,
                  ),
                  if (onDelete != null)
                    Padding(
                      padding: const EdgeInsets.only(left: 4),
                      child: GestureDetector(
                        onTap: onDelete,
                        behavior: HitTestBehavior.opaque,
                        child: const Icon(
                          Icons.close,
                          size: 18,
                          color: Color(0xFF8E8E93),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const Divider(height: 1, thickness: 1, color: Color(0xFFF2F2F7)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: posting.amountController,
                    focusNode: posting.amountFocusNode,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                      signed: true,
                    ),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(
                        RegExp(r'^-?\d*\.?\d*'),
                      ),
                    ],
                    decoration: const InputDecoration(
                      border: InputBorder.none,
                      hintText: '0.00',
                      hintStyle: TextStyle(color: Color(0xFFC7C7CC)),
                      isDense: true,
                      contentPadding: EdgeInsets.zero,
                    ),
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w500,
                      color: Color(0xFF1C1C1E),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                _CurrencyButton(
                  symbol: posting.currency,
                  onTap: onCurrencyTap,
                  primary: true,
                ),
              ],
            ),
          ),
          // Cost row (only when the posting originally had a cost).
          if (posting.costAmountController != null) ...[
            const Divider(height: 1, thickness: 1, color: Color(0xFFF2F2F7)),
            _AuxMoneyRow(
              label: 'Cost',
              controller: posting.costAmountController!,
              focusNode: posting.costFocusNode,
              currency: posting.costCurrency ?? '…',
              onCurrencyTap: onCostCurrencyTap,
            ),
          ],
          if (posting.priceAmountController != null) ...[
            const Divider(height: 1, thickness: 1, color: Color(0xFFF2F2F7)),
            _AuxMoneyRow(
              label: 'Price',
              controller: posting.priceAmountController!,
              focusNode: posting.priceFocusNode,
              currency: posting.priceCurrency ?? '…',
              onCurrencyTap: onPriceCurrencyTap,
            ),
          ],
        ],
      ),
    );
  }
}

class _AuxMoneyRow extends StatelessWidget {
  final String label;
  final TextEditingController controller;
  final FocusNode? focusNode;
  final String currency;
  final VoidCallback onCurrencyTap;

  const _AuxMoneyRow({
    required this.label,
    required this.controller,
    this.focusNode,
    required this.currency,
    required this.onCurrencyTap,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          SizedBox(
            width: 44,
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 13,
                color: Color(0xFF8E8E93),
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              inputFormatters: [
                FilteringTextInputFormatter.allow(RegExp(r'^\d*\.?\d*')),
              ],
              decoration: const InputDecoration(
                border: InputBorder.none,
                hintText: '0.00',
                hintStyle: TextStyle(color: Color(0xFFC7C7CC)),
                isDense: true,
                contentPadding: EdgeInsets.zero,
              ),
              style: const TextStyle(fontSize: 14, color: Color(0xFF1C1C1E)),
            ),
          ),
          const SizedBox(width: 8),
          _CurrencyButton(
            symbol: currency,
            onTap: onCurrencyTap,
            primary: false,
          ),
        ],
      ),
    );
  }
}

class _CurrencyButton extends StatelessWidget {
  final String symbol;
  final VoidCallback onTap;
  final bool primary;

  const _CurrencyButton({
    required this.symbol,
    required this.onTap,
    required this.primary,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: primary ? const Color(0xFFEBF2FE) : const Color(0xFFF2F2F7),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              symbol.isEmpty ? '…' : symbol,
              style: TextStyle(
                fontSize: primary ? 13 : 12,
                fontWeight: FontWeight.w600,
                color: primary
                    ? const Color(0xFF1A73E8)
                    : const Color(0xFF8E8E93),
              ),
            ),
            const SizedBox(width: 2),
            Icon(
              Icons.keyboard_arrow_down,
              size: primary ? 14 : 12,
              color: primary
                  ? const Color(0xFF1A73E8)
                  : const Color(0xFF8E8E93),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _AddPostingRow extends StatelessWidget {
  final VoidCallback? onTap;

  const _AddPostingRow({this.onTap});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFE5E5EA)),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: onTap != null
                      ? const Color(0xFFEBF2FE)
                      : const Color(0xFFF2F2F7),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(
                  Icons.add,
                  color: onTap != null
                      ? const Color(0xFF1A73E8)
                      : const Color(0xFFC7C7CC),
                  size: 20,
                ),
              ),
              const SizedBox(width: 12),
              Text(
                onTap == null ? 'Loading accounts…' : 'Add posting',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: onTap != null
                      ? const Color(0xFF1A73E8)
                      : const Color(0xFFC7C7CC),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _ImbalanceWarning extends StatelessWidget {
  final List<({String symbol, double amount})> imbalances;

  const _ImbalanceWarning({required this.imbalances});

  @override
  Widget build(BuildContext context) {
    final formatted = imbalances
        .map((i) => '${formatFixedAmount(i.amount.abs())} ${i.symbol}')
        .join(', ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xFFFFF3CD),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: const Color(0xFFFFD60A)),
        ),
        child: Row(
          children: [
            const Icon(
              Icons.warning_amber_rounded,
              color: Color(0xFFCC8400),
              size: 18,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'Unbalanced: $formatted',
                style: const TextStyle(
                  fontSize: 13,
                  color: Color(0xFF6D4C00),
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
