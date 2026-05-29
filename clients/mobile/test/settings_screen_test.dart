import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:family_ledger_mobile/core/api_client.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/core/secure_settings.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/repositories/account_repository.dart';
import 'package:family_ledger_mobile/repositories/commodity_repository.dart';
import 'package:family_ledger_mobile/screens/settings/settings_screen.dart';

class MockSecureSettings extends Mock implements SecureSettings {}

class MockApiClient extends Mock implements ApiClient {}

class MockAccountRepository extends Mock implements AccountRepository {}

class MockCommodityRepository extends Mock implements CommodityRepository {}

const _prefKeyDefaultFrom = 'last_from_account_name';
const _prefKeyDefaultCurrency = 'default_currency';

AccountResource _acct(String accountName) => AccountResource(
  name: 'accounts/${accountName.toLowerCase().replaceAll(':', '_')}',
  accountName: accountName,
  effectiveStartDate: '2020-01-01',
);

Commodity _commodity(String symbol) =>
    Commodity(name: 'commodities/${symbol.toLowerCase()}', symbol: symbol);

void main() {
  late MockSecureSettings mockSettings;
  late MockApiClient mockApiClient;
  late MockAccountRepository mockRepo;
  late MockCommodityRepository mockCommodityRepo;

  setUp(() {
    mockSettings = MockSecureSettings();
    mockApiClient = MockApiClient();
    mockRepo = MockAccountRepository();
    mockCommodityRepo = MockCommodityRepository();

    when(
      () => mockSettings.getBaseUrl(),
    ).thenAnswer((_) async => 'http://example.com');
    when(() => mockSettings.getToken()).thenAnswer((_) async => 'token');
    when(() => mockSettings.saveBaseUrl(any())).thenAnswer((_) async {});
    when(() => mockSettings.saveToken(any())).thenAnswer((_) async {});
    when(() => mockRepo.invalidateCache()).thenReturn(null);
    when(
      () => mockCommodityRepo.getAllCommodities(),
    ).thenAnswer((_) async => (data: <Commodity>[], error: null));
  });

  Widget buildScreen({VoidCallback? onSaved}) => MaterialApp(
    home: SettingsScreen(
      settings: mockSettings,
      apiClient: mockApiClient,
      accountRepository: mockRepo,
      commodityRepository: mockCommodityRepo,
      onSaved: onSaved,
    ),
  );

  group('SettingsScreen default From account', () {
    testWidgets('shows None when no default is stored', (tester) async {
      SharedPreferences.setMockInitialValues({});
      when(() => mockRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: [_acct('Assets:Cash:Wallet')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('None'), findsWidgets);
    });

    testWidgets('shows stored account displayName on open', (tester) async {
      SharedPreferences.setMockInitialValues({
        _prefKeyDefaultFrom: 'Assets:Cash:Wallet',
      });
      when(() => mockRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: [_acct('Assets:Cash:Wallet')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
    });

    testWidgets('shows None when stored account no longer exists in list', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        _prefKeyDefaultFrom: 'Assets:Cash:OldWallet',
      });
      when(() => mockRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: [_acct('Assets:Cash:Wallet')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsNothing);
    });

    testWidgets(
      'picking an account updates display and saves to SharedPreferences',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(() => mockRepo.getAllAccounts()).thenAnswer(
          (_) async => (
            data: [_acct('Assets:Cash:Wallet'), _acct('Expenses:Food')],
            error: null,
          ),
        );

        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        // Tap the From row (first 'None')
        await tester.tap(find.text('None').first);
        await tester.pumpAndSettle();

        expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
        await tester.tap(find.text('Assets · Cash · Wallet'));
        await tester.pumpAndSettle();

        expect(find.text('Assets · Cash · Wallet'), findsOneWidget);

        final prefs = await SharedPreferences.getInstance();
        expect(prefs.getString(_prefKeyDefaultFrom), 'Assets:Cash:Wallet');
      },
    );

    testWidgets(
      'row is disabled and tap does nothing when accounts failed to load',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(() => mockRepo.getAllAccounts()).thenAnswer(
          (_) async => (data: null, error: const NetworkError('unreachable')),
        );

        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('None').first);
        await tester.pumpAndSettle();

        expect(find.text('Settings'), findsOneWidget);
        expect(find.text('Select Account'), findsNothing);
      },
    );

    testWidgets('accounts reload after successful test connection', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      when(() => mockRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('unreachable')),
      );
      when(() => mockApiClient.checkHealth()).thenAnswer((_) async => null);
      when(
        () => mockApiClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: {'accounts': []}, error: null));

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      when(() => mockRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: [_acct('Assets:Cash:Wallet')], error: null),
      );

      await tester.tap(find.text('Test Connection'));
      await tester.pumpAndSettle();

      verify(() => mockRepo.getAllAccounts()).called(2);
    });
  });

  group('SettingsScreen default Currency', () {
    testWidgets('shows None when no default currency is stored', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      when(
        () => mockRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async =>
            (data: [_commodity('CHF'), _commodity('EUR')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      // Both From and Currency show 'None' — find all
      expect(find.text('None'), findsWidgets);
    });

    testWidgets('shows stored default currency on open', (tester) async {
      SharedPreferences.setMockInitialValues({_prefKeyDefaultCurrency: 'EUR'});
      when(
        () => mockRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async =>
            (data: [_commodity('CHF'), _commodity('EUR')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('EUR'), findsOneWidget);
    });

    testWidgets(
      'picking a currency updates display and saves to SharedPreferences',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(
          () => mockRepo.getAllAccounts(),
        ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
        when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
          (_) async =>
              (data: [_commodity('CHF'), _commodity('EUR')], error: null),
        );

        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        // Tap the Currency row (last 'None')
        await tester.tap(find.text('None').last);
        await tester.pumpAndSettle();

        // Bottom sheet shows commodities
        expect(find.text('CHF'), findsOneWidget);
        expect(find.text('EUR'), findsOneWidget);

        await tester.tap(find.text('EUR'));
        await tester.pumpAndSettle();

        expect(find.text('EUR'), findsOneWidget);

        final prefs = await SharedPreferences.getInstance();
        expect(prefs.getString(_prefKeyDefaultCurrency), 'EUR');
      },
    );

    testWidgets('currency row is disabled when no commodities loaded', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      when(
        () => mockRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('unreachable')),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      // Tap the Currency 'None' row — should not open bottom sheet
      await tester.tap(find.text('None').last);
      await tester.pumpAndSettle();

      expect(find.text('Default Currency'), findsNothing);
    });
  });

  group('SettingsScreen onSaved callback', () {
    testWidgets('calls onSaved instead of Navigator.pop when provided', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      when(
        () => mockRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));

      var savedCalled = false;
      await tester.pumpWidget(buildScreen(onSaved: () => savedCalled = true));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(savedCalled, isTrue);
    });

    testWidgets('Navigator.pop is called when onSaved is not provided', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      when(
        () => mockRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => Navigator.push<bool>(
                context,
                MaterialPageRoute(
                  builder: (_) => SettingsScreen(
                    settings: mockSettings,
                    apiClient: mockApiClient,
                    accountRepository: mockRepo,
                    commodityRepository: mockCommodityRepo,
                  ),
                ),
              ),
              child: const Text('Open Settings'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open Settings'));
      await tester.pumpAndSettle();

      expect(find.text('Settings'), findsOneWidget);

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(find.text('Open Settings'), findsOneWidget);
      expect(find.text('Settings'), findsNothing);
    });
  });
}
