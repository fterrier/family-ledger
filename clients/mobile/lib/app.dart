import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'core/api_client.dart';
import 'core/secure_settings.dart';
import 'repositories/account_repository.dart';
import 'repositories/commodity_repository.dart';
import 'repositories/importer_repository.dart';
import 'repositories/transaction_repository.dart';
import 'screens/add_transaction/add_transaction_screen.dart';
import 'screens/import/import_screen.dart';
import 'screens/settings/settings_screen.dart';
import 'screens/transactions/transaction_list_screen.dart';

class FamilyLedgerApp extends StatefulWidget {
  const FamilyLedgerApp({super.key});

  @override
  State<FamilyLedgerApp> createState() => _FamilyLedgerAppState();
}

class _FamilyLedgerAppState extends State<FamilyLedgerApp> {
  static const _shareChannel = MethodChannel('com.familyledger/share');

  final _settings = SecureSettings();
  late final ApiClient _apiClient;
  late final AccountRepository _accountRepo;
  late final CommodityRepository _commodityRepo;
  late final TransactionRepository _transactionRepo;
  late final ImporterRepository _importerRepo;

  bool? _configured;
  final _listKey = GlobalKey<TransactionListScreenState>();

  @override
  void initState() {
    super.initState();
    _apiClient = ApiClient(_settings);
    _accountRepo = AccountRepository(_apiClient);
    _commodityRepo = CommodityRepository(_apiClient);
    _transactionRepo = TransactionRepository(_apiClient);
    _importerRepo = ImporterRepository(_apiClient);
    _checkConfiguration();
    _initShareChannel();
  }

  void _initShareChannel() {
    // Warm launch: app already running when user shares a file.
    _shareChannel.setMethodCallHandler((call) async {
      if (call.method == 'receiveFile') {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        _handleSharedFile(args['path'] as String, args['mimeType'] as String?);
      }
    });

    // Cold launch: query for any file that arrived before Dart was ready.
    _shareChannel.invokeMapMethod<String, dynamic>('getInitialFile').then((
      file,
    ) {
      if (file != null) {
        _handleSharedFile(file['path'] as String, file['mimeType'] as String?);
      }
    });
  }

  void _handleSharedFile(String filePath, String? mimeType) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _openImport(filePath: filePath, mimeType: mimeType);
    });
  }

  @override
  void dispose() {
    _shareChannel.setMethodCallHandler(null);
    super.dispose();
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

  Future<void> _openImport({String? filePath, String? mimeType}) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => ImportScreen(
          importerRepository: _importerRepo,
          onOpenSettings: _openSettings,
          initialFilePath: filePath,
          initialMimeType: mimeType,
        ),
      ),
    );
  }

  Future<void> _openAddTransaction() async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => AddTransactionScreen(
          accountRepository: _accountRepo,
          commodityRepository: _commodityRepo,
          transactionRepository: _transactionRepo,
          onOpenSettings: _openSettings,
        ),
      ),
    );
    _listKey.currentState?.refresh();
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
            icon: const Icon(Icons.upload_file_outlined),
            onPressed: () => _openImport(),
            tooltip: 'Import',
          ),
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: _openSettings,
            tooltip: 'Settings',
          ),
        ],
      ),
      backgroundColor: const Color(0xFFF2F2F7),
      body: TransactionListScreen(
        key: _listKey,
        transactionRepository: _transactionRepo,
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _openAddTransaction,
        backgroundColor: const Color(0xFF1A73E8),
        foregroundColor: Colors.white,
        child: const Icon(Icons.add),
      ),
    );
  }
}
