import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'core/api_client.dart';
import 'core/app_preferences.dart';
import 'core/filter_persistence.dart';
import 'core/secure_settings.dart';
import 'repositories/account_repository.dart';
import 'repositories/commodity_repository.dart';
import 'repositories/importer_repository.dart';
import 'repositories/query_repository.dart';
import 'repositories/transaction_repository.dart';
import 'screens/settings/app_settings_screen.dart';
import 'screens/settings/server_settings_screen.dart';
import 'models/account.dart';
import 'screens/add_transaction/account_picker_screen.dart';
import 'screens/add_transaction/add_transaction_screen.dart';
import 'screens/import/import_screen.dart';
import 'screens/transactions/transaction_filter.dart';
import 'screens/transactions/transaction_list_screen.dart';
import 'widgets/app_logo.dart';
import 'widgets/expandable_fab.dart';

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
  late final QueryRepository _queryRepo;

  bool? _configured;
  final _listKey = GlobalKey<TransactionListScreenState>();
  final _filterActive = ValueNotifier<bool>(false);
  final _bulkSelectionNotifier = ValueNotifier<Set<String>>({});

  @override
  void initState() {
    super.initState();
    _apiClient = ApiClient(_settings);
    _accountRepo = AccountRepository(_apiClient);
    _commodityRepo = CommodityRepository(_apiClient);
    _transactionRepo = TransactionRepository(_apiClient);
    _importerRepo = ImporterRepository(_apiClient);
    _queryRepo = QueryRepository(_apiClient);
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
    _filterActive.dispose();
    _bulkSelectionNotifier.dispose();
    super.dispose();
  }

  Future<void> _checkConfiguration() async {
    final ok = await _settings.isConfigured();
    setState(() => _configured = ok);
  }

  // Clears all server-specific state. Add new caches here — screen code does
  // not need to change when a new cache is introduced.
  Future<void> _invalidateServerCache() async {
    _accountRepo.invalidateCache();
    _commodityRepo.invalidateCache();
    await Future.wait([
      FilterPersistence.save(const TransactionFilter()),
      AppPreferences.clear(),
    ]);
  }

  Future<void> _openServerSettings() async {
    final saved = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => ServerSettingsScreen(
          settings: _settings,
          apiClient: _apiClient,
          onServerChanged: _invalidateServerCache,
        ),
      ),
    );
    if (saved == true) _checkConfiguration();
  }

  // Drawer "Accounts": picking an account IS setting the global filter's
  // account — the home screen then shows the chart + scoped list.
  Future<void> _openAccounts() async {
    final listState = _listKey.currentState;
    if (listState == null) return;
    final result = await Navigator.push<AccountResource>(
      context,
      MaterialPageRoute(
        builder: (_) => AccountPickerScreen(
          accounts: listState.pickerAccounts,
          selected: listState.selectedAccount,
          issueAccountNames: listState.accountsWithAssertionIssues,
        ),
      ),
    );
    if (result != null) {
      _listKey.currentState?.selectAccount(result);
    }
  }

  Future<void> _openAppSettings() async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => AppSettingsScreen(
          accountRepository: _accountRepo,
          commodityRepository: _commodityRepo,
        ),
      ),
    );
  }

  Future<void> _openImport({String? filePath, String? mimeType}) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => ImportScreen(
          importerRepository: _importerRepo,
          onOpenSettings: _openServerSettings,
          initialFilePath: filePath,
          initialMimeType: mimeType,
        ),
      ),
    );
  }

  Future<void> _openAddTransaction() async {
    final saved = await Navigator.push<bool>(
      context,
      MaterialPageRoute(
        builder: (_) => AddTransactionScreen(
          accountRepository: _accountRepo,
          commodityRepository: _commodityRepo,
          transactionRepository: _transactionRepo,
          onOpenSettings: _openServerSettings,
        ),
      ),
    );
    _listKey.currentState?.refresh();
    if (saved == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Transaction saved'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  static final _appBarDivider = PreferredSize(
    preferredSize: const Size.fromHeight(1),
    child: Container(height: 1, color: const Color(0xFFE5E5EA)),
  );

  AppBar _buildNormalAppBar() {
    return AppBar(
      title: const Text('Family Ledger'),
      titleSpacing: 0,
      backgroundColor: Colors.white,
      foregroundColor: const Color(0xFF1C1C1E),
      elevation: 0,
      bottom: _appBarDivider,
      actions: [
        ValueListenableBuilder<bool>(
          valueListenable: _filterActive,
          builder: (context, active, child) => Stack(
            children: [
              IconButton(
                icon: const Icon(Icons.filter_list_outlined),
                onPressed: () => _listKey.currentState?.openFilter(),
                tooltip: 'Filter',
              ),
              if (active)
                Positioned(
                  right: 8,
                  top: 8,
                  child: Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(
                      color: Color(0xFF1A73E8),
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  AppBar _buildSelectionAppBar(Set<String> selected) {
    return AppBar(
      leading: IconButton(
        icon: const Icon(Icons.close),
        onPressed: () => _listKey.currentState?.exitSelectionMode(),
      ),
      title: Text('${selected.length} selected'),
      backgroundColor: Colors.white,
      foregroundColor: const Color(0xFF1C1C1E),
      elevation: 0,
      bottom: _appBarDivider,
      actions: [
        IconButton(
          icon: const Icon(Icons.delete_outline),
          onPressed: () => _listKey.currentState?.deleteSelected(),
          tooltip: 'Delete',
        ),
        PopupMenuButton<String>(
          icon: const Icon(Icons.more_vert),
          onSelected: (value) {
            if (value == 'merge') _listKey.currentState?.mergeSelected();
          },
          itemBuilder: (_) => [
            PopupMenuItem(
              value: 'merge',
              enabled: selected.length == 2,
              child: const Text('Merge'),
            ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_configured == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!_configured!) {
      return ServerSettingsScreen(
        settings: _settings,
        apiClient: _apiClient,
        onSaved: _checkConfiguration,
        onServerChanged: _invalidateServerCache,
      );
    }
    return ListenableBuilder(
      listenable: _bulkSelectionNotifier,
      builder: (context, _) {
        final selected = _bulkSelectionNotifier.value;
        final isSelecting = selected.isNotEmpty;
        return Scaffold(
          drawer: isSelecting
              ? null
              : Drawer(
                  child: ListView(
                    padding: EdgeInsets.zero,
                    children: [
                      const DrawerHeader(
                        decoration: BoxDecoration(color: Colors.white),
                        child: Row(
                          children: [
                            AppLogo(),
                            SizedBox(width: 10),
                            Text(
                              'Family Ledger',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w600,
                                color: Color(0xFF1C1C1E),
                              ),
                            ),
                          ],
                        ),
                      ),
                      ListTile(
                        leading: const Icon(Icons.account_balance_outlined),
                        title: const Text('Accounts'),
                        onTap: () {
                          Navigator.pop(context);
                          _openAccounts();
                        },
                      ),
                      ListTile(
                        leading: const Icon(Icons.tune_outlined),
                        title: const Text('App Settings'),
                        onTap: () {
                          Navigator.pop(context);
                          _openAppSettings();
                        },
                      ),
                      ListTile(
                        leading: const Icon(Icons.dns_outlined),
                        title: const Text('Server'),
                        onTap: () {
                          Navigator.pop(context);
                          _openServerSettings();
                        },
                      ),
                    ],
                  ),
                ),
          appBar: isSelecting
              ? _buildSelectionAppBar(selected)
              : _buildNormalAppBar(),
          backgroundColor: const Color(0xFFF2F2F7),
          body: TransactionListScreen(
            key: _listKey,
            transactionRepository: _transactionRepo,
            accountRepository: _accountRepo,
            commodityRepository: _commodityRepo,
            queryRepository: _queryRepo,
            filterActiveNotifier: _filterActive,
            selectionNotifier: _bulkSelectionNotifier,
          ),
          floatingActionButton: isSelecting
              ? null
              : ExpandableFab(
                  onAddTransaction: _openAddTransaction,
                  onImport: _openImport,
                ),
        );
      },
    );
  }
}
