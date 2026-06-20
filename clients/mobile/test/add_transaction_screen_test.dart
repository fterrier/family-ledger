import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
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

const _prefKeyLastFrom = 'last_from_account_name';
const _prefKeyDefaultCurrency = 'default_currency';

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

  Future<void> fillAndSubmit(
    WidgetTester tester, {
    String amount = '42.50',
  }) async {
    await tester.pumpWidget(buildScreen());
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
    await tester.ensureVisible(find.text('Add Transaction'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add Transaction'));
    await tester.pumpAndSettle();
  }

  group('AddTransactionScreen initial load', () {
    testWidgets('shows From account from SharedPreferences on open', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        _prefKeyLastFrom: 'Assets:Cash:Wallet',
      });

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
    });

    testWidgets('shows default currency from SharedPreferences on open', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({_prefKeyDefaultCurrency: 'EUR'});
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

    testWidgets('submits correct payload and resets form', (tester) async {
      await fillAndSubmit(tester);

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
      expect(find.text('Transaction saved'), findsOneWidget);
      expect(find.text('42.50'), findsNothing);
    });

    testWidgets('saves From account name to SharedPreferences on submit', (
      tester,
    ) async {
      await fillAndSubmit(tester, amount: '10');

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(_prefKeyLastFrom), 'Assets:Cash:Wallet');
    });

    testWidgets('shows API error in banner on failed submit', (tester) async {
      when(
        () => mockTransactionRepo.createTransaction(any()),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      await fillAndSubmit(tester);

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

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, '42.50');
      await tester.tap(find.text('Select account…').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Assets · Cash · Wallet'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Select account…').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Expenses · Food'));
      await tester.pumpAndSettle();
      // Narration is the third TextField (after amount and payee)
      await tester.enterText(find.byType(TextField).at(2), 'Weekly groceries');
      await tester.ensureVisible(find.text('Add Transaction'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add Transaction'));
      await tester.pumpAndSettle();

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

      await fillAndSubmit(tester);

      final tx =
          verify(
                () => mockTransactionRepo.createTransaction(captureAny()),
              ).captured.first
              as TransactionCreate;
      expect(tx.narration, isNull);
    });

    testWidgets('narration is cleared after successful submit', (tester) async {
      when(
        () => mockTransactionRepo.createTransaction(any()),
      ).thenAnswer((_) async => (data: <String, dynamic>{}, error: null));

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, '42.50');
      await tester.tap(find.text('Select account…').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Assets · Cash · Wallet'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Select account…').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Expenses · Food'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).at(2), 'Weekly groceries');
      await tester.ensureVisible(find.text('Add Transaction'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add Transaction'));
      await tester.pumpAndSettle();

      expect(
        (tester.widget<TextField>(find.byType(TextField).at(2)).controller)!
            .text,
        isEmpty,
      );
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
}
