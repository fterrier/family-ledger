import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/core/app_preferences.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/models/transaction.dart';
import 'package:family_ledger_mobile/repositories/account_repository.dart';
import 'package:family_ledger_mobile/repositories/commodity_repository.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';
import 'package:family_ledger_mobile/screens/add_transaction/add_transaction_screen.dart';
import 'package:family_ledger_mobile/widgets/error_banner.dart';

class MockAccountRepository extends Mock implements AccountRepository {}

class MockCommodityRepository extends Mock implements CommodityRepository {}

class MockTransactionRepository extends Mock implements TransactionRepository {}

AccountResource _acct(String accountName) => AccountResource(
  name: 'accounts/${accountName.toLowerCase().replaceAll(':', '_')}',
  accountName: accountName,
  effectiveStartDate: '2020-01-01',
);

Commodity _commodity(String symbol) =>
    Commodity(name: 'commodities/${symbol.toLowerCase()}', symbol: symbol);

void main() {
  late MockAccountRepository mockAccountRepo;
  late MockCommodityRepository mockCommodityRepo;
  late MockTransactionRepository mockTransactionRepo;

  setUp(() {
    mockAccountRepo = MockAccountRepository();
    mockCommodityRepo = MockCommodityRepository();
    mockTransactionRepo = MockTransactionRepository();

    registerFallbackValue(
      const TransactionCreate(transactionDate: '2026-01-01', postings: []),
    );

    // Default stubs — tests that need different data override these.
    SharedPreferences.setMockInitialValues({});
    when(() => mockAccountRepo.getAllAccounts()).thenAnswer(
      (_) async => (
        data: [_acct('Assets:Cash:Wallet'), _acct('Expenses:Food')],
        error: null,
      ),
    );
    when(
      () => mockCommodityRepo.getAllCommodities(),
    ).thenAnswer((_) async => (data: [_commodity('CHF')], error: null));
  });

  Widget buildScreen({VoidCallback? onOpenSettings}) => MaterialApp(
    home: AddTransactionScreen(
      accountRepository: mockAccountRepo,
      commodityRepository: mockCommodityRepo,
      transactionRepository: mockTransactionRepo,
      onOpenSettings: onOpenSettings,
    ),
  );

  // AddTransactionScreen is always pushed onto a stack in the real app and
  // pops itself on a successful save — mounting it directly as `home` can't
  // exercise that. This mounts a placeholder "Open" screen underneath and
  // pushes AddTransactionScreen on top, capturing the pop result.
  Future<bool?> pushAddTransactionAndSubmit(
    WidgetTester tester, {
    String amount = '42.50',
    String? narration,
  }) async {
    bool? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  result = await Navigator.push<bool>(
                    context,
                    MaterialPageRoute(
                      builder: (_) => AddTransactionScreen(
                        accountRepository: mockAccountRepo,
                        commodityRepository: mockCommodityRepo,
                        transactionRepository: mockTransactionRepo,
                      ),
                    ),
                  );
                },
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, amount);
    await tester.tap(find.text('Select account…').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Assets · Cash · Wallet'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Select account…').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Expenses · Food'));
    await tester.pumpAndSettle();
    if (narration != null) {
      await tester.enterText(find.byType(TextField).at(2), narration);
    }
    await tester.ensureVisible(find.text('Add Transaction'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add Transaction'));
    await tester.pumpAndSettle();

    return result;
  }

  group('AddTransactionScreen initial load', () {
    testWidgets('shows default From account from SharedPreferences on open', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        AppPreferences.keyDefaultFrom: 'Assets:Cash:Wallet',
      });

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
    });

    testWidgets('shows default currency from SharedPreferences on open', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        AppPreferences.keyDefaultCurrency: 'EUR',
      });
      when(
        () => mockAccountRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async =>
            (data: [_commodity('CHF'), _commodity('EUR')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('EUR'), findsOneWidget);
    });

    testWidgets('defaults currency to first commodity when no pref set', (
      tester,
    ) async {
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async =>
            (data: [_commodity('CHF'), _commodity('EUR')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('CHF'), findsOneWidget);
    });

    testWidgets('shows error banner when accounts fail to load', (
      tester,
    ) async {
      when(() => mockAccountRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('unreachable')),
      );
      when(
        () => mockCommodityRepo.getAllCommodities(),
      ).thenAnswer((_) async => (data: <Commodity>[], error: null));

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.byType(ErrorBanner), findsOneWidget);
    });

    testWidgets('retry reloads accounts after network error', (tester) async {
      when(() => mockAccountRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('unreachable')),
      );
      when(
        () => mockCommodityRepo.getAllCommodities(),
      ).thenAnswer((_) async => (data: <Commodity>[], error: null));

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      when(() => mockAccountRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: [_acct('Assets:Cash:Wallet')], error: null),
      );

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(find.byType(ErrorBanner), findsNothing);
      verify(() => mockAccountRepo.getAllAccounts()).called(2);
    });
  });

  group('AddTransactionScreen validation', () {
    testWidgets('submit with no amount/from/to shows validation error', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Add Transaction'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add Transaction'));
      await tester.pumpAndSettle();

      expect(find.byType(ErrorBanner), findsOneWidget);
      verifyNever(() => mockTransactionRepo.createTransaction(any()));
    });

    testWidgets('submit with zero amount shows validation error', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).first, '0');
      await tester.ensureVisible(find.text('Add Transaction'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add Transaction'));
      await tester.pumpAndSettle();

      expect(find.byType(ErrorBanner), findsOneWidget);
      verifyNever(() => mockTransactionRepo.createTransaction(any()));
    });
  });

  group('AddTransactionScreen successful submit', () {
    setUp(() {
      when(
        () => mockTransactionRepo.createTransaction(any()),
      ).thenAnswer((_) async => (data: <String, dynamic>{}, error: null));
    });

    testWidgets('submits correct payload and returns to the previous screen', (
      tester,
    ) async {
      final result = await pushAddTransactionAndSubmit(tester);

      final captured = verify(
        () => mockTransactionRepo.createTransaction(captureAny()),
      ).captured;
      final tx = captured.first as TransactionCreate;
      expect(tx.postings.length, 2);
      expect(tx.postings[0].units.amount, '-42.50');
      expect(tx.postings[0].units.symbol, 'CHF');
      expect(tx.postings[1].units.amount, '42.50');
      expect(tx.postings[0].account, contains('assets'));
      expect(tx.postings[1].account, contains('expenses'));

      expect(result, isTrue);
      expect(find.byType(AddTransactionScreen), findsNothing);
      expect(find.text('Open'), findsOneWidget);
    });

    testWidgets(
      'does not overwrite the default From account preference on submit',
      (tester) async {
        SharedPreferences.setMockInitialValues({
          AppPreferences.keyDefaultFrom: 'Assets:Cash:Wallet',
        });
        when(() => mockAccountRepo.getAllAccounts()).thenAnswer(
          (_) async => (
            data: [
              _acct('Assets:Cash:Wallet'),
              _acct('Assets:Cash:Savings'),
              _acct('Expenses:Food'),
            ],
            error: null,
          ),
        );

        bool? result;
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () async {
                    result = await Navigator.push<bool>(
                      context,
                      MaterialPageRoute(
                        builder: (_) => AddTransactionScreen(
                          accountRepository: mockAccountRepo,
                          commodityRepository: mockCommodityRepo,
                          transactionRepository: mockTransactionRepo,
                        ),
                      ),
                    );
                  },
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();

        // From is preselected with the configured default (Wallet) — tap it
        // to reassign it to a different account before submitting.
        await tester.enterText(find.byType(TextField).first, '10');
        await tester.tap(find.text('Assets · Cash · Wallet'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Assets · Cash · Savings'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Select account…').first);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Expenses · Food'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Add Transaction'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Add Transaction'));
        await tester.pumpAndSettle();

        expect(result, isTrue);
        final prefs = await SharedPreferences.getInstance();
        expect(
          prefs.getString(AppPreferences.keyDefaultFrom),
          'Assets:Cash:Wallet',
        );
      },
    );

    testWidgets('shows API error in banner on failed submit', (tester) async {
      when(
        () => mockTransactionRepo.createTransaction(any()),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      await pushAddTransactionAndSubmit(tester);

      expect(find.byType(ErrorBanner), findsOneWidget);
    });
  });

  group('AddTransactionScreen narration field', () {
    testWidgets('narration field is shown in the form', (tester) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('Narration'), findsOneWidget);
    });

    testWidgets('submitting with narration includes it in the payload', (
      tester,
    ) async {
      when(
        () => mockTransactionRepo.createTransaction(any()),
      ).thenAnswer((_) async => (data: <String, dynamic>{}, error: null));

      await pushAddTransactionAndSubmit(tester, narration: 'Weekly groceries');

      final tx =
          verify(
                () => mockTransactionRepo.createTransaction(captureAny()),
              ).captured.first
              as TransactionCreate;
      expect(tx.narration, 'Weekly groceries');
    });

    testWidgets('submitting without narration sets it to null', (tester) async {
      when(
        () => mockTransactionRepo.createTransaction(any()),
      ).thenAnswer((_) async => (data: <String, dynamic>{}, error: null));

      await pushAddTransactionAndSubmit(tester);

      final tx =
          verify(
                () => mockTransactionRepo.createTransaction(captureAny()),
              ).captured.first
              as TransactionCreate;
      expect(tx.narration, isNull);
    });
  });

  group('AddTransactionScreen payee placeholder', () {
    testWidgets('payee field shows descriptive hint text', (tester) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      // Find the payee TextField (second TextField after amount)
      final payeeField = tester.widget<TextField>(find.byType(TextField).at(1));
      expect(payeeField.decoration?.hintText, isNot('optional…'));
      expect(payeeField.decoration?.hintText, isNotNull);
    });
  });

  group('AddTransactionScreen currency picker', () {
    testWidgets('currency picker bottom sheet shows commodities and updates', (
      tester,
    ) async {
      when(
        () => mockAccountRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async =>
            (data: [_commodity('CHF'), _commodity('EUR')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      await tester.tap(find.text('CHF'));
      await tester.pumpAndSettle();

      expect(find.text('CHF'), findsWidgets);
      expect(find.text('EUR'), findsOneWidget);

      await tester.tap(find.text('EUR'));
      await tester.pumpAndSettle();

      expect(find.text('EUR'), findsOneWidget);
    });
  });

  group('AddTransactionScreen swap accounts', () {
    testWidgets('swap button exchanges the From and To accounts', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Select account…').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Assets · Cash · Wallet'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Select account…').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Expenses · Food'));
      await tester.pumpAndSettle();

      // FROM renders above TO — capture that ordering before swapping.
      final fromDyBefore = tester
          .getTopLeft(find.text('Assets · Cash · Wallet'))
          .dy;
      final toDyBefore = tester.getTopLeft(find.text('Expenses · Food')).dy;
      expect(fromDyBefore, lessThan(toDyBefore));

      await tester.tap(find.byTooltip('Swap accounts'));
      await tester.pumpAndSettle();

      final fromDyAfter = tester.getTopLeft(find.text('Expenses · Food')).dy;
      final toDyAfter = tester
          .getTopLeft(find.text('Assets · Cash · Wallet'))
          .dy;
      expect(fromDyAfter, lessThan(toDyAfter));
    });

    testWidgets('swap with only From selected moves it to To', (tester) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Select account…').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Assets · Cash · Wallet'));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Swap accounts'));
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
      expect(find.text('Select account…'), findsOneWidget);
    });
  });
}
