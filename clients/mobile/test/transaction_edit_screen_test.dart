import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/core/result.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/models/doctor_issue.dart';
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
      weight: MoneyValue(amount: '-42.50', symbol: 'CHF'),
    ),
    PostingResource(
      account: 'accounts/acc_food',
      accountName: 'Expenses:Food',
      units: MoneyValue(amount: '42.50', symbol: 'CHF'),
      weight: MoneyValue(amount: '42.50', symbol: 'CHF'),
    ),
  ],
);

TransactionResource _stockTx() => const TransactionResource(
  name: 'transactions/t3',
  transactionDate: '2026-06-18',
  payee: 'Broker',
  postings: [
    PostingResource(
      account: 'accounts/acc_broker_usd',
      accountName: 'Assets:Broker:USD',
      units: MoneyValue(amount: '-11779.00', symbol: 'USD'),
      weight: MoneyValue(amount: '-11779.00', symbol: 'USD'),
    ),
    PostingResource(
      account: 'accounts/acc_broker_vss',
      accountName: 'Assets:Broker:VSS',
      units: MoneyValue(amount: '100', symbol: 'VSS'),
      cost: MoneyValue(amount: '117.79', symbol: 'USD'),
      weight: MoneyValue(amount: '11779.00', symbol: 'USD'),
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
      weight: MoneyValue(amount: '-30.00', symbol: 'CHF'),
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
    when(
      () => mockTransactionRepo.normalizeTransaction(any()),
    ).thenAnswer((_) async => (data: <DoctorIssue>[], error: null));
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

    testWidgets(
      'focus/blur reformatting (comma insertion/removal) does not trigger '
      'an extra normalize check when the numeric value has not changed '
      '(regression: wireAmountFocus reformatting the display text on '
      'focus change used to look like an edit to the debounce)',
      (tester) async {
        var callCount = 0;
        when(() => mockTransactionRepo.normalizeTransaction(any())).thenAnswer((
          _,
        ) async {
          callCount++;
          return (data: <DoctorIssue>[], error: null);
        });
        const tx = TransactionResource(
          name: 'transactions/t4',
          transactionDate: '2026-06-18',
          postings: [
            PostingResource(
              account: 'accounts/acc_checking',
              accountName: 'Assets:Bank:Checking',
              units: MoneyValue(amount: '-1234.50', symbol: 'CHF'),
              weight: MoneyValue(amount: '-1234.50', symbol: 'CHF'),
            ),
            PostingResource(
              account: 'accounts/acc_food',
              accountName: 'Expenses:Food',
              units: MoneyValue(amount: '1234.50', symbol: 'CHF'),
              weight: MoneyValue(amount: '1234.50', symbol: 'CHF'),
            ),
          ],
        );

        await tester.pumpWidget(buildScreen(tx));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pumpAndSettle();
        expect(callCount, 1);

        // Tap into the first posting's amount field — index 2, after the
        // header's payee (0) and narration (1) fields — which strips the
        // comma on focus gain ('1,234.50' -> '1234.50'), then move focus
        // elsewhere so focus loss re-adds it — a pure display-format round
        // trip, no real edit.
        await tester.tap(find.byType(TextField).at(2));
        await tester.pump();
        await tester.tap(find.byType(TextField).at(0));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pumpAndSettle();

        expect(callCount, 1);
      },
    );

    testWidgets('shows imbalance warning for unbalanced transaction', (
      tester,
    ) async {
      when(() => mockTransactionRepo.normalizeTransaction(any())).thenAnswer(
        (_) async => (
          data: [
            const DoctorIssue(
              code: 'transaction_unbalanced',
              details: {'symbol': 'CHF', 'residual_amount': '-30'},
            ),
          ],
          error: null,
        ),
      );

      await tester.pumpWidget(buildScreen(_unbalancedTx()));
      await tester.pump(const Duration(milliseconds: 500));
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

    testWidgets(
      'no imbalance warning for a stock transaction balanced via cost '
      '(regression: raw units (100 VSS vs -11779 USD) never balance — '
      'the check must use weight, i.e. cost, like the server does), and '
      'the client sends cost through untouched rather than computing '
      'weight itself',
      (tester) async {
        await tester.pumpWidget(buildScreen(_stockTx()));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pumpAndSettle();

        expect(find.textContaining('Unbalanced'), findsNothing);

        final captured = verify(
          () => mockTransactionRepo.normalizeTransaction(captureAny()),
        ).captured;
        expect(captured, isNotEmpty);
        final sent = captured.last as TransactionUpdate;
        final vss = sent.postings.firstWhere((p) => p.units.symbol == 'VSS');
        expect(vss.cost?.amount, '117.79');
        expect(vss.cost?.symbol, 'USD');
      },
    );

    testWidgets(
      'a slow, superseded normalize response must not overwrite a later, '
      'faster one (regression: no generation guard would let a stale '
      'response silently replace the current imbalance state)',
      (tester) async {
        final responses = <Completer<Result<List<DoctorIssue>>>>[];
        when(() => mockTransactionRepo.normalizeTransaction(any())).thenAnswer((
          _,
        ) {
          final completer = Completer<Result<List<DoctorIssue>>>();
          responses.add(completer);
          return completer.future;
        });

        await tester.pumpWidget(buildScreen(_balancedTx()));
        await tester.pump(const Duration(milliseconds: 500));
        // The initial (no-edit) check fired on open.
        expect(responses.length, 1);
        responses[0].complete((data: <DoctorIssue>[], error: null));
        await tester.pumpAndSettle();

        // First edit — its debounced check (call #2) is left pending.
        await tester.enterText(find.byType(TextField).at(2), '-42.51');
        await tester.pump(const Duration(milliseconds: 500));
        expect(responses.length, 2);

        // Second, later edit — its check (call #3) is the one that should
        // win once both resolve.
        await tester.enterText(find.byType(TextField).at(2), '-42.52');
        await tester.pump(const Duration(milliseconds: 500));
        expect(responses.length, 3);

        // The later call resolves first (faster network) with no issues.
        responses[2].complete((data: <DoctorIssue>[], error: null));
        await tester.pump();
        expect(find.textContaining('Unbalanced'), findsNothing);

        // The earlier, now-superseded call resolves after it, claiming an
        // imbalance — this must be discarded, not applied.
        responses[1].complete((
          data: [
            const DoctorIssue(
              code: 'transaction_unbalanced',
              details: {'symbol': 'CHF', 'residual_amount': '0.01'},
            ),
          ],
          error: null,
        ));
        await tester.pump();
        expect(find.textContaining('Unbalanced'), findsNothing);
      },
    );

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
