import 'package:flutter/material.dart';
import 'core/api_client.dart';
import 'core/secure_settings.dart';
import 'repositories/account_repository.dart';
import 'repositories/commodity_repository.dart';
import 'repositories/transaction_repository.dart';
import 'screens/add_transaction/add_transaction_screen.dart';
import 'screens/settings/settings_screen.dart';

class FamilyLedgerApp extends StatefulWidget {
  const FamilyLedgerApp({super.key});

  @override
  State<FamilyLedgerApp> createState() => _FamilyLedgerAppState();
}

class _FamilyLedgerAppState extends State<FamilyLedgerApp> {
  final _settings = SecureSettings();
  late final ApiClient _apiClient;
  late final AccountRepository _accountRepo;
  late final CommodityRepository _commodityRepo;
  late final TransactionRepository _transactionRepo;

  bool? _configured;

  @override
  void initState() {
    super.initState();
    _apiClient = ApiClient(_settings);
    _accountRepo = AccountRepository(_apiClient);
    _commodityRepo = CommodityRepository(_apiClient);
    _transactionRepo = TransactionRepository(_apiClient);
    _checkConfiguration();
  }

  Future<void> _checkConfiguration() async {
    final ok = await _settings.isConfigured();
    setState(() => _configured = ok);
  }

  Future<void> _openSettings() async {
    final saved = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => SettingsScreen(
          settings: _settings,
          apiClient: _apiClient,
          accountRepository: _accountRepo,
          commodityRepository: _commodityRepo,
        ),
      ),
    );
    if (saved == true) _checkConfiguration();
  }

  @override
  Widget build(BuildContext context) {
    if (_configured == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!_configured!) {
      return SettingsScreen(
        settings: _settings,
        apiClient: _apiClient,
        accountRepository: _accountRepo,
        commodityRepository: _commodityRepo,
        onSaved: _checkConfiguration,
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Family Ledger'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1C1C1E),
        elevation: 0,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: const Color(0xFFE5E5EA)),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: _openSettings,
            tooltip: 'Settings',
          ),
        ],
      ),
      backgroundColor: const Color(0xFFF2F2F7),
      body: AddTransactionScreen(
        accountRepository: _accountRepo,
        commodityRepository: _commodityRepo,
        transactionRepository: _transactionRepo,
        onOpenSettings: _openSettings,
      ),
    );
  }
}
