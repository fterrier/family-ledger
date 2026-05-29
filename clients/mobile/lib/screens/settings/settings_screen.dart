import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/api_client.dart';
import '../../core/api_error.dart';
import '../../core/secure_settings.dart';
import '../../models/account.dart';
import '../../models/commodity.dart';
import '../../repositories/account_repository.dart';
import '../../repositories/commodity_repository.dart';
import '../../widgets/currency_picker_sheet.dart';
import '../add_transaction/account_picker_screen.dart';

class SettingsScreen extends StatefulWidget {
  final SecureSettings settings;
  final ApiClient apiClient;
  final AccountRepository accountRepository;
  final CommodityRepository commodityRepository;
  // Called instead of Navigator.pop when screen is shown as the initial setup
  // screen (not pushed onto the navigator stack).
  final VoidCallback? onSaved;

  const SettingsScreen({
    super.key,
    required this.settings,
    required this.apiClient,
    required this.accountRepository,
    required this.commodityRepository,
    this.onSaved,
  });

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  static const _prefKeyDefaultFrom = 'last_from_account_name';
  static const _prefKeyDefaultCurrency = 'default_currency';

  final _formKey = GlobalKey<FormState>();
  final _urlController = TextEditingController();
  final _tokenController = TextEditingController();
  bool _tokenVisible = false;
  bool _testing = false;
  String? _testResult;
  bool _testOk = false;

  SharedPreferences? _prefs;
  List<AccountResource>? _accounts;
  List<Commodity>? _commodities;
  bool _loadingAccounts = false;
  AccountResource? _defaultFromAccount;
  String? _defaultCurrency;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final (url, token) = await (
      widget.settings.getBaseUrl(),
      widget.settings.getToken(),
    ).wait;
    if (!mounted) return;
    setState(() {
      _urlController.text = url ?? '';
      _tokenController.text = token ?? '';
    });
    _loadAccountsAndDefault();
  }

  Future<void> _loadAccountsAndDefault() async {
    setState(() => _loadingAccounts = true);
    final (accountsResult, commoditiesResult, prefs) = await (
      widget.accountRepository.getAllAccounts(),
      widget.commodityRepository.getAllCommodities(),
      SharedPreferences.getInstance(),
    ).wait;
    _prefs = prefs;
    final defaultFromName = prefs.getString(_prefKeyDefaultFrom);
    final defaultCurrency = prefs.getString(_prefKeyDefaultCurrency);
    if (!mounted) return;
    setState(() {
      _loadingAccounts = false;
      if (accountsResult.data != null) {
        _accounts = accountsResult.data!.where((a) => a.isActive).toList();
        if (defaultFromName != null) {
          _defaultFromAccount = _accounts!.firstWhereOrNull(
            (a) => a.accountName == defaultFromName,
          );
        }
      }
      if (commoditiesResult.data != null) {
        _commodities = commoditiesResult.data;
        _defaultCurrency = defaultCurrency;
      }
    });
  }

  Future<void> _pickDefaultFromAccount() async {
    if (_accounts == null) return;
    final result = await Navigator.push<AccountResource>(
      context,
      MaterialPageRoute(
        builder: (_) => AccountPickerScreen(
          accounts: _accounts!,
          selected: _defaultFromAccount,
        ),
      ),
    );
    if (result != null && mounted) {
      setState(() => _defaultFromAccount = result);
      await _prefs!.setString(_prefKeyDefaultFrom, result.accountName);
    }
  }

  Future<void> _pickDefaultCurrency() async {
    if (_commodities == null || _commodities!.isEmpty) return;
    final result = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => CurrencyPickerSheet(
        commodities: _commodities!,
        selected: _defaultCurrency,
        title: 'Default Currency',
      ),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
    );
    if (result != null && mounted) {
      setState(() => _defaultCurrency = result);
      await _prefs!.setString(_prefKeyDefaultCurrency, result);
    }
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    await (
      widget.settings.saveBaseUrl(_urlController.text),
      widget.settings.saveToken(_tokenController.text),
    ).wait;
    widget.accountRepository.invalidateCache();
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Settings saved')));
      if (widget.onSaved != null) {
        widget.onSaved!();
      } else {
        Navigator.pop(context, true);
      }
    }
  }

  Future<void> _testConnection() async {
    await (
      widget.settings.saveBaseUrl(_urlController.text),
      widget.settings.saveToken(_tokenController.text),
    ).wait;

    setState(() {
      _testing = true;
      _testResult = null;
    });

    final healthErr = await widget.apiClient.checkHealth();
    if (healthErr != null) {
      setState(() {
        _testing = false;
        _testOk = false;
        _testResult = 'Cannot reach server. Check the URL.';
      });
      return;
    }

    final result = await widget.apiClient.get(
      '/accounts',
      queryParams: {'page_size': '1'},
    );
    setState(() {
      _testing = false;
      if (result.error != null) {
        _testOk = false;
        _testResult = switch (result.error!) {
          AuthError() => 'Authentication failed. Check your token.',
          NetworkError() => 'Cannot reach server. Check the URL.',
          MissingSettingsError() => 'Server not configured.',
          ValidationError(:final message) || ServerError(:final message) =>
            'Server error: $message',
        };
      } else {
        _testOk = true;
        _testResult = 'Connected successfully';
        if (_accounts == null || _commodities == null) _loadAccountsAndDefault();
      }
    });
  }

  @override
  void dispose() {
    _urlController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF2F2F7),
      appBar: AppBar(
        title: const Text('Settings'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1C1C1E),
        elevation: 0,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: const Color(0xFFE5E5EA)),
        ),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          children: [
            _sectionHeader('Server'),
            _card([
              _fieldRow(
                label: 'API URL',
                child: TextFormField(
                  controller: _urlController,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(
                    border: InputBorder.none,
                    hintText: 'http://100.64.x.x:8000',
                    hintStyle: TextStyle(color: Color(0xFFC7C7CC)),
                    isDense: true,
                    contentPadding: EdgeInsets.zero,
                  ),
                  style: const TextStyle(fontSize: 15),
                  validator: (v) =>
                      (v == null || v.trim().isEmpty) ? 'Required' : null,
                ),
              ),
              const Divider(height: 1, color: Color(0xFFF2F2F7)),
              _fieldRow(
                label: 'Token',
                child: TextFormField(
                  controller: _tokenController,
                  obscureText: !_tokenVisible,
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: EdgeInsets.zero,
                    suffixIcon: TextButton(
                      onPressed: () =>
                          setState(() => _tokenVisible = !_tokenVisible),
                      child: Text(
                        _tokenVisible ? 'Hide' : 'Show',
                        style: const TextStyle(
                          fontSize: 13,
                          color: Color(0xFF1A73E8),
                        ),
                      ),
                    ),
                  ),
                  style: const TextStyle(fontSize: 15),
                  validator: (v) =>
                      (v == null || v.trim().isEmpty) ? 'Required' : null,
                ),
              ),
            ]),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: OutlinedButton(
                onPressed: _testing ? null : _testConnection,
                style: OutlinedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  side: const BorderSide(color: Color(0xFF1A73E8)),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
                child: _testing
                    ? const SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text(
                        'Test Connection',
                        style: TextStyle(
                          fontSize: 15,
                          color: Color(0xFF1A73E8),
                        ),
                      ),
              ),
            ),
            if (_testResult != null)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                child: Text(
                  _testResult!,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 13,
                    color: _testOk
                        ? const Color(0xFF34C759)
                        : const Color(0xFFD93025),
                  ),
                ),
              ),
            _sectionHeader('Defaults'),
            _card([
              _pickerRow(
                label: 'From',
                value: _defaultFromAccount?.displayName,
                loading: _loadingAccounts,
                onTap: _accounts != null ? _pickDefaultFromAccount : null,
              ),
              const Divider(height: 1, color: Color(0xFFF2F2F7)),
              _pickerRow(
                label: 'Currency',
                value: _defaultCurrency,
                loading: _loadingAccounts,
                onTap: (_commodities?.isNotEmpty ?? false)
                    ? _pickDefaultCurrency
                    : null,
              ),
            ]),
            const SizedBox(height: 16),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: ElevatedButton(
                onPressed: _save,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF1A73E8),
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                  elevation: 0,
                ),
                child: const Text(
                  'Save',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionHeader(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 20, 16, 6),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w600,
        color: Color(0xFF8E8E93),
        letterSpacing: 0.5,
      ),
    ),
  );

  Widget _card(List<Widget> children) => Container(
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
    child: Column(children: children),
  );

  Widget _fieldRow({required String label, required Widget child}) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    child: Row(
      children: [
        SizedBox(
          width: 72,
          child: Text(
            label,
            style: const TextStyle(fontSize: 13, color: Color(0xFF8E8E93)),
          ),
        ),
        Expanded(child: child),
      ],
    ),
  );

  Widget _pickerRow({
    required String label,
    required String? value,
    required bool loading,
    required VoidCallback? onTap,
  }) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(14),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Row(
        children: [
          SizedBox(
            width: 72,
            child: Text(
              label,
              style: const TextStyle(fontSize: 13, color: Color(0xFF8E8E93)),
            ),
          ),
          Expanded(
            child: loading
                ? const SizedBox(
                    height: 14,
                    width: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(
                    value ?? 'None',
                    style: TextStyle(
                      fontSize: 15,
                      color: value != null
                          ? const Color(0xFF1C1C1E)
                          : const Color(0xFFC7C7CC),
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
          ),
          Icon(
            Icons.chevron_right,
            color: onTap != null
                ? const Color(0xFFC7C7CC)
                : const Color(0xFFE5E5EA),
            size: 20,
          ),
        ],
      ),
    ),
  );
}
