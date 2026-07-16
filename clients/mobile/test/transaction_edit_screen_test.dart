import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/models/posting.dart';
import 'package:family_ledger_mobile/models/transaction.dart';
import 'package:family_ledger_mobile/repositories/account_repository.dart';
import 'package:family_ledger_mobile/repositories/commodity_repository.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';
import 'package:family_ledger_mobile/screens/transaction_edit/transaction_edit_screen.dart';
import 'package:family_ledger_mobile/widgets/error_banner.dart';

class MockTransactionRepository extends Mock implements TransactionRepository {}

class MockAccountRepository extends Mock implements AccountRepository {}

class MockCommodityRepository extends Mock implements CommodityRepository {}

AccountResource _acct(String accountName) => AccountResource(
  name: 'accounts/${accountName.toLowerCase().replaceAll(':', '_')}',
  accountName: accountName,
  effectiveStartDate: '2020-01-01',
);

Commodity _commodity(String symbol) =>
    Commodity(name: 'commodities/${symbol.toLowerCase()}', symbol: symbol);

TransactionResource _balancedTx() => const TransactionResource(
  name: 'transactions/t1',
  transactionDate: '2026-06-18',
  payee: 'Migros',
  narration: 'Groceries',
  postings: [
    PostingResource(
      account: 'accounts/acc_checking',
      accountName: 'Assets:Bank:Checking',
      units: MoneyValue(amount: '-42.50', symbol: 'CHF'),
    ),
    PostingResource(
      account: 'accounts/acc_food',
      accountName: 'Expenses:Food',
      units: MoneyValue(amount: '42.50', symbol: 'CHF'),
    ),
  ],
);

TransactionResource _unbalancedTx() => const TransactionResource(
  name: 'transactions/t2',
  transactionDate: '2026-06-18',
  payee: 'Coop',
  postings: [
    PostingResource(
      account: 'accounts/acc_checking',
      accountName: 'Assets:Bank:Checking',
      units: MoneyValue(amount: '-30.00', symbol: 'CHF'),
    ),
  ],
);

void main() {
  late MockTransactionRepository mockTransactionRepo;
  late MockAccountRepository mockAccountRepo;
  late MockCommodityRepository mockCommodityRepo;

  setUp(() {
    mockTransactionRepo = MockTransactionRepository();
    mockAccountRepo = MockAccountRepository();
    mockCommodityRepo = MockCommodityRepository();

    registerFallbackValue(
      const TransactionUpdate(transactionDate: '2026-01-01', postings: []),
    );

    when(() => mockAccountRepo.getAllAccounts()).thenAnswer(
      (_) async => (
        data: [_acct('Assets:Bank:Checking'), _acct('Expenses:Food')],
        error: null,
      ),
    );
    when(
      () => mockCommodityRepo.getAllCommodities(),
    ).thenAnswer((_) async => (data: [_commodity('CHF')], error: null));
  });

  Widget buildScreen(TransactionResource tx) => MaterialApp(
    home: TransactionEditScreen(
      transaction: tx,
      transactionRepository: mockTransactionRepo,
      accountRepository: mockAccountRepo,
      commodityRepository: mockCommodityRepo,
    ),
  );

  group('initial render', () {
    testWidgets('shows header fields pre-filled from transaction', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      expect(find.text('Migros'), findsOneWidget);
      expect(find.text('Groceries'), findsOneWidget);
    });

    testWidgets('shows posting rows for each posting', (tester) async {
      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      expect(find.textContaining('-42.50'), findsOneWidget);
      expect(find.textContaining('42.50'), findsWidgets);
    });

    testWidgets('shows imbalance warning for unbalanced transaction', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(_unbalancedTx()));
      await tester.pumpAndSettle();

      expect(find.textContaining('Unbalanced'), findsOneWidget);
      expect(find.textContaining('30.00'), findsWidgets);
    });

    testWidgets('no imbalance warning for balanced transaction', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      expect(find.textContaining('Unbalanced'), findsNothing);
    });

    testWidgets('shows "Add posting" row', (tester) async {
      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      expect(find.text('Add posting'), findsOneWidget);
    });
  });

  group('delete posting', () {
    testWidgets('delete button is hidden when only one posting', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(_unbalancedTx()));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.close), findsNothing);
    });

    testWidgets('delete button is shown when multiple postings', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.close), findsWidgets);
    });

    testWidgets('tapping delete removes the posting row', (tester) async {
      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      // Tap the first × button.
      await tester.tap(find.byIcon(Icons.close).first);
      await tester.pumpAndSettle();

      // Now only one posting → delete button is gone.
      expect(find.byIcon(Icons.close), findsNothing);
    });
  });

  group('save', () {
    testWidgets('calls updateTransaction then getTransaction on save', (
      tester,
    ) async {
      final saved = _balancedTx();
      when(
        () => mockTransactionRepo.updateTransaction(any(), any()),
      ).thenAnswer((_) async => (data: saved, error: null));
      when(
        () => mockTransactionRepo.getTransaction('transactions/t1'),
      ).thenAnswer((_) async => (data: saved, error: null));

      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      verify(
        () => mockTransactionRepo.updateTransaction(any(), any()),
      ).called(1);
      verify(
        () => mockTransactionRepo.getTransaction('transactions/t1'),
      ).called(1);
    });

    testWidgets('shows error banner when save fails', (tester) async {
      when(
        () => mockTransactionRepo.updateTransaction(any(), any()),
      ).thenAnswer(
        (_) async =>
            (data: null, error: const NetworkError('connection refused')),
      );

      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(find.byType(ErrorBanner), findsOneWidget);
    });

    testWidgets('pops with updated transaction on success', (tester) async {
      TransactionEditResult? poppedWith;
      final updated = _balancedTx();
      when(
        () => mockTransactionRepo.updateTransaction(any(), any()),
      ).thenAnswer((_) async => (data: updated, error: null));
      when(
        () => mockTransactionRepo.getTransaction('transactions/t1'),
      ).thenAnswer((_) async => (data: updated, error: null));

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                final result = await Navigator.push<TransactionEditResult>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => TransactionEditScreen(
                      transaction: _balancedTx(),
                      transactionRepository: mockTransactionRepo,
                      accountRepository: mockAccountRepo,
                      commodityRepository: mockCommodityRepo,
                    ),
                  ),
                );
                poppedWith = result;
              },
              child: const Text('Open'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(poppedWith?.$1.name, 'transactions/t1');
      expect(poppedWith?.$2, isNull);
    });
  });

  group('account/commodity loading error', () {
    testWidgets('shows error banner when accounts fail to load', (
      tester,
    ) async {
      when(() => mockAccountRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('no network')),
      );

      await tester.pumpWidget(buildScreen(_balancedTx()));
      await tester.pumpAndSettle();

      expect(find.byType(ErrorBanner), findsOneWidget);
    });
  });
}
