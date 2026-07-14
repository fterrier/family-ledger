import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/models/doctor_issue.dart';
import 'package:family_ledger_mobile/models/posting.dart';
import 'package:family_ledger_mobile/models/transaction.dart';
import 'package:family_ledger_mobile/repositories/account_repository.dart';
import 'package:family_ledger_mobile/repositories/commodity_repository.dart';
import 'package:family_ledger_mobile/models/query_result.dart';
import 'package:family_ledger_mobile/repositories/query_repository.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_list_screen.dart';
import 'package:family_ledger_mobile/widgets/account_chart_card.dart';
import 'package:family_ledger_mobile/widgets/error_banner.dart';
import 'package:family_ledger_mobile/widgets/issue_bar.dart';

typedef _DoctorResult = ({List<DoctorIssue>? data, ApiError? error});

bool _hasRedLeftBorder(WidgetTester tester) =>
    find.byType(IssueBar).evaluate().isNotEmpty;

class MockTransactionRepository extends Mock implements TransactionRepository {}

class MockAccountRepository extends Mock implements AccountRepository {}

class MockCommodityRepository extends Mock implements CommodityRepository {}

class MockQueryRepository extends Mock implements QueryRepository {}

typedef _ListResult = ({
  (List<TransactionResource>, String?)? data,
  ApiError? error,
});

DoctorIssue _issue(String target) =>
    DoctorIssue(target: target, code: 'unbalanced_transaction');

TransactionResource _tx({
  String name = 'transactions/t1',
  String date = '2026-06-18',
  String? payee = 'Migros',
  String? narration = 'Groceries',
  String amount = '-42.50',
  String symbol = 'CHF',
  // Under the default home view's Assets root so the row amount (the sum
  // of postings under the current view's roots) shows this posting.
  String accountName = 'Assets:Bank:Checking',
}) => TransactionResource(
  name: name,
  transactionDate: date,
  payee: payee,
  narration: narration,
  postings: [
    PostingResource(
      account: 'accounts/acc_checking',
      accountName: accountName,
      units: MoneyValue(amount: amount, symbol: symbol),
    ),
  ],
);

void main() {
  late MockTransactionRepository mockRepo;
  late MockAccountRepository mockAccountRepo;
  late MockCommodityRepository mockCommodityRepo;
  late MockQueryRepository mockQueryRepo;

  setUpAll(() {
    registerFallbackValue(
      const TransactionUpdate(transactionDate: '2026-01-01', postings: []),
    );
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    mockRepo = MockTransactionRepository();
    mockAccountRepo = MockAccountRepository();
    mockCommodityRepo = MockCommodityRepository();
    mockQueryRepo = MockQueryRepository();
    // Default: chart queries return an empty series
    when(() => mockQueryRepo.run(any())).thenAnswer(
      (_) async => (
        data: const QueryResult(columns: [], rows: [], warnings: []),
        error: null,
      ),
    );
    // Default: doctor returns no issues (keeps existing tests unaffected)
    when(
      () => mockRepo.runDoctorIssues(),
    ).thenAnswer((_) async => (data: <DoctorIssue>[], error: null));
    when(
      () => mockRepo.getYearRange(),
    ).thenAnswer((_) async => (data: (2024, 2026), error: null));
    // Default stubs for account/commodity repos (used when edit screen opens)
    when(
      () => mockAccountRepo.getAllAccounts(),
    ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
    when(
      () => mockCommodityRepo.getAllCommodities(),
    ).thenAnswer((_) async => (data: <Commodity>[], error: null));
  });

  Widget buildScreen() => MaterialApp(
    home: Scaffold(
      body: TransactionListScreen(
        transactionRepository: mockRepo,
        accountRepository: mockAccountRepo,
        commodityRepository: mockCommodityRepo,
        queryRepository: mockQueryRepo,
      ),
    ),
  );

  testWidgets('shows loading indicator while fetching', (tester) async {
    final completer = Completer<_ListResult>();
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) => completer.future);

    await tester.pumpWidget(buildScreen());
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsAny);

    completer.complete((data: (<TransactionResource>[], null), error: null));
    await tester.pumpAndSettle();
  });

  testWidgets('renders transaction row after successful load', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(find.text('Migros'), findsOneWidget);
    expect(find.text('Groceries'), findsOneWidget);
    expect(find.text('-42.50 CHF'), findsOneWidget);
    expect(find.text('Jun 18'), findsOneWidget);
  });

  group('view-aware row amounts', () {
    TransactionResource multiPostingTx(List<PostingResource> postings) =>
        TransactionResource(
          name: 'transactions/tm',
          transactionDate: '2026-06-18',
          payee: 'Migros',
          postings: postings,
        );

    PostingResource posting(
      String accountName,
      String amount,
      String symbol, {
      MoneyValue? converted,
    }) => PostingResource(
      account: 'accounts/acc-x',
      accountName: accountName,
      units: MoneyValue(amount: amount, symbol: symbol),
      convertedUnits: converted,
    );

    Future<void> pumpWith(WidgetTester tester, TransactionResource tx) async {
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
          convert: any(named: 'convert'),
        ),
      ).thenAnswer((_) async => (data: ([tx], null), error: null));
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();
    }

    testWidgets('selected account: sum of the subtree postings only', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        // Prefix pseudo-accounts persist the account path as their name.
        'tx_filter_account_name': 'Assets:Bank',
        'tx_filter_account_display_name': 'Assets:Bank',
        'tx_filter_account_is_prefix': true,
      });
      await pumpWith(
        tester,
        multiPostingTx([
          posting('Assets:Bank:Checking', '-60.00', 'CHF'),
          posting('Assets:Bank:Savings', '-40.00', 'CHF'),
          posting('Expenses:Food', '100.00', 'CHF'),
        ]),
      );

      expect(find.text('-100.00 CHF'), findsOneWidget);
      expect(find.text('100.00 CHF'), findsNothing);
    });

    testWidgets('home balance sheet: nets Assets and Liabilities postings', (
      tester,
    ) async {
      await pumpWith(
        tester,
        multiPostingTx([
          posting('Assets:Checking', '-500.00', 'CHF'),
          posting('Liabilities:Card', '300.00', 'CHF'),
          posting('Expenses:Rent', '200.00', 'CHF'),
        ]),
      );

      // Net-worth change: -500 + 300 (raw signs).
      expect(find.text('-200.00 CHF'), findsOneWidget);
    });

    testWidgets('home income statement: sums Income and Expenses raw', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        'tx_filter_home_view': 'incomeStatement',
      });
      await pumpWith(
        tester,
        multiPostingTx([
          posting('Income:Salary', '-5000.00', 'CHF'),
          posting('Assets:Checking', '5000.00', 'CHF'),
        ]),
      );

      expect(find.text('-5,000.00 CHF'), findsOneWidget);
    });

    testWidgets('no posting under the view roots shows an em dash', (
      tester,
    ) async {
      await pumpWith(
        tester,
        multiPostingTx([
          posting('Equity:Opening', '-999.00', 'CHF'),
          posting('Equity:Adjustments', '999.00', 'CHF'),
        ]),
      );

      expect(find.text('—'), findsOneWidget);
    });

    testWidgets(
      'foreign postings show the converted sum with originals underneath',
      (tester) async {
        SharedPreferences.setMockInitialValues({'default_currency': 'CHF'});
        await pumpWith(
          tester,
          multiPostingTx([
            posting('Assets:Checking', '-10.00', 'CHF'),
            posting(
              'Assets:Broker',
              '40',
              'USD',
              converted: const MoneyValue(amount: '34', symbol: 'CHF'),
            ),
          ]),
        );

        expect(find.text('24.00 CHF'), findsOneWidget);
        expect(find.text('40.00 USD'), findsOneWidget);
      },
    );

    testWidgets('unconvertible foreign postings keep their raw sum', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({'default_currency': 'CHF'});
      await pumpWith(
        tester,
        multiPostingTx([posting('Assets:Wallet', '500', 'JPY')]),
      );

      expect(find.text('500.00 JPY'), findsOneWidget);
    });

    // Invariant (single currency, no date filter): the sum of the displayed
    // row amounts equals the chart headline — the income statement's
    // headline is the sum of its buckets, and the balance sheet's is the
    // latest net worth of a series that starts from zero.
    QueryResult yearlyBuckets(List<(int, String)> rows) => QueryResult(
      columns: const [
        QueryColumnDef(name: 'y', type: 'int'),
        QueryColumnDef(name: 'bal', type: 'amount'),
      ],
      rows: [
        for (final (year, number) in rows)
          [year, QueryAmount(number: number, currency: 'CHF')],
      ],
      warnings: const [],
    );

    testWidgets('invariant: income-statement rows sum to the chart headline', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        'default_currency': 'CHF',
        'tx_filter_home_view': 'incomeStatement',
      });
      when(
        () => mockQueryRepo.run(any(that: contains('sum(position)'))),
      ).thenAnswer(
        (_) async => (
          data: yearlyBuckets([(2025, '-5000'), (2026, '1500')]),
          error: null,
        ),
      );
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
          convert: any(named: 'convert'),
        ),
      ).thenAnswer(
        (_) async => (
          data: (
            [
              TransactionResource(
                name: 'transactions/t-salary',
                transactionDate: '2025-07-05',
                payee: 'Employer',
                postings: [
                  posting('Income:Salary', '-5000.00', 'CHF'),
                  posting('Assets:Checking', '5000.00', 'CHF'),
                ],
              ),
              TransactionResource(
                name: 'transactions/t-rent',
                transactionDate: '2026-01-03',
                payee: 'Landlord',
                postings: [
                  posting('Expenses:Rent', '1500.00', 'CHF'),
                  posting('Assets:Checking', '-1500.00', 'CHF'),
                ],
              ),
            ],
            null,
          ),
          error: null,
        ),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      // Rows: -5000 (income) and +1500 (expense); headline: their sum.
      expect(find.text('-5,000.00 CHF'), findsOneWidget);
      expect(find.text('1,500.00 CHF'), findsOneWidget);
      expect(find.text('-3,500.00 CHF'), findsOneWidget);
    });

    testWidgets('invariant: balance-sheet rows sum to the chart headline', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({'default_currency': 'CHF'});
      when(
        () => mockQueryRepo.run(any(that: contains('last(balance)'))),
      ).thenAnswer(
        (_) async =>
            (data: yearlyBuckets([(2025, '1000'), (2026, '800')]), error: null),
      );
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
          convert: any(named: 'convert'),
        ),
      ).thenAnswer(
        (_) async => (
          data: (
            [
              TransactionResource(
                name: 'transactions/t-open',
                transactionDate: '2025-05-10',
                payee: 'Opening',
                postings: [
                  posting('Assets:Checking', '1000.00', 'CHF'),
                  posting('Equity:Opening', '-1000.00', 'CHF'),
                ],
              ),
              TransactionResource(
                name: 'transactions/t-card',
                transactionDate: '2026-02-01',
                payee: 'Card payment due',
                postings: [
                  posting('Liabilities:Card', '-200.00', 'CHF'),
                  posting('Expenses:Stuff', '200.00', 'CHF'),
                ],
              ),
            ],
            null,
          ),
          error: null,
        ),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      // Rows: +1000 and -200 net-worth changes; headline: the latest net
      // worth, 800 — their sum (the series starts from zero, no OPEN ON).
      expect(find.text('1,000.00 CHF'), findsOneWidget);
      expect(find.text('-200.00 CHF'), findsOneWidget);
      expect(find.text('800.00 CHF'), findsOneWidget);
    });
  });

  testWidgets('empty list still leads with the home chart card', (
    tester,
  ) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer(
      (_) async => (data: (<TransactionResource>[], null), error: null),
    );

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(find.byType(AccountChartCard), findsOneWidget);
    expect(find.text('No transactions in range'), findsOneWidget);
  });

  testWidgets('shows error banner on load failure', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer(
      (_) async => (data: null, error: const NetworkError('timeout')),
    );

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(find.textContaining('Cannot reach server'), findsOneWidget);
  });

  testWidgets('uses narration as primary text when payee is null', (
    tester,
  ) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer(
      (_) async => (
        data: ([_tx(payee: null, narration: 'Monthly rent')], null),
        error: null,
      ),
    );

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(find.text('Monthly rent'), findsOneWidget);
  });

  testWidgets('loads next page when user scrolls to the bottom', (
    tester,
  ) async {
    // 30 items × ~55px each ≈ 1650px total; viewport is 600px, so extentAfter ≈ 1050px
    // at the top — above the 800px threshold, so no auto-fetch on load.
    // After dragging to the bottom, extentAfter drops to 0 — below the 800px threshold.
    final firstPage = List.generate(
      30,
      (i) =>
          _tx(name: 'transactions/t$i', date: '2026-06-01', payee: 'Payee $i'),
    );

    final calls = <String?>[];
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((invocation) async {
      final token = invocation.namedArguments[#pageToken] as String?;
      calls.add(token);
      return token == null
          ? (data: (firstPage, 'page2'), error: null)
          : (
              data: (
                [
                  _tx(
                    name: 'transactions/next',
                    date: '2026-05-01',
                    payee: 'Coop',
                  ),
                ],
                null,
              ),
              error: null,
            );
    });

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();
    expect(calls, [null]);

    // Drag up by a large amount to scroll past the load-more threshold.
    await tester.drag(find.byType(ListView), const Offset(0, -5000));
    await tester.pumpAndSettle();

    // Both pages fetched: second call used the page token from the first response.
    expect(calls, [null, 'page2']);
    // Total item count in the list grew to 21.
    expect(find.byType(ListView), findsOneWidget);
  });

  testWidgets('pull-to-refresh reloads the list', (tester) async {
    var callCount = 0;
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) async {
      callCount++;
      return (data: ([_tx()], null), error: null);
    });

    final key = GlobalKey<TransactionListScreenState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TransactionListScreen(
            key: key,
            transactionRepository: mockRepo,
            accountRepository: mockAccountRepo,
            commodityRepository: mockCommodityRepo,
            queryRepository: mockQueryRepo,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(callCount, 1);

    key.currentState?.refresh();
    await tester.pumpAndSettle();

    expect(callCount, 2);
  });

  testWidgets('refresh() while page 2 in-flight discards the stale result', (
    tester,
  ) async {
    final page1 = List.generate(
      30,
      (i) => _tx(
        name: 'transactions/p1t$i',
        date: '2026-06-01',
        payee: 'Payee $i',
      ),
    );
    final page1Refresh = [
      _tx(name: 'transactions/new', payee: 'New', narration: null),
    ];

    final page2Completer = Completer<_ListResult>();
    final refreshCompleter = Completer<_ListResult>();
    final calls = <String?>[];
    var callIndex = 0;

    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((inv) {
      final token = inv.namedArguments[#pageToken] as String?;
      calls.add(token);
      final i = callIndex++;
      if (i == 0) return Future.value((data: (page1, 'tok'), error: null));
      if (i == 1) return page2Completer.future; // page 2 hangs
      return refreshCompleter.future; // refresh fetch
    });

    final key = GlobalKey<TransactionListScreenState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TransactionListScreen(
            key: key,
            transactionRepository: mockRepo,
            accountRepository: mockAccountRepo,
            commodityRepository: mockCommodityRepo,
            queryRepository: mockQueryRepo,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(calls, [null]);

    await tester.drag(find.byType(ListView), const Offset(0, -5000));
    await tester.pump();
    expect(calls, [null, 'tok']);

    key.currentState?.refresh();
    await tester.pump();
    expect(calls, [null, 'tok', null]);

    // Stale page 2 resolves first — should be silently discarded
    page2Completer.complete((
      data: (
        [_tx(name: 'transactions/stale', date: '2026-05-01', payee: 'Stale')],
        null,
      ),
      error: null,
    ));
    await tester.pump();

    refreshCompleter.complete((data: (page1Refresh, null), error: null));
    await tester.pumpAndSettle();

    expect(find.text('New'), findsOneWidget);
    expect(find.text('Stale'), findsNothing);
  });

  testWidgets(
    'refresh() while page 2 in-flight discards stale result even when stale resolves last',
    (tester) async {
      final page1 = List.generate(
        20,
        (i) => _tx(
          name: 'transactions/p1t$i',
          date: '2026-06-01',
          payee: 'Payee $i',
        ),
      );
      final page1Refresh = [
        _tx(name: 'transactions/new2', payee: 'New2', narration: null),
      ];

      final page2Completer = Completer<_ListResult>();
      final refreshCompleter = Completer<_ListResult>();
      final calls = <String?>[];
      var callIndex = 0;

      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer((inv) {
        final token = inv.namedArguments[#pageToken] as String?;
        calls.add(token);
        final i = callIndex++;
        if (i == 0) return Future.value((data: (page1, 'tok'), error: null));
        if (i == 1) return page2Completer.future;
        return refreshCompleter.future;
      });

      final key = GlobalKey<TransactionListScreenState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              key: key,
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.drag(find.byType(ListView), const Offset(0, -5000));
      await tester.pump();
      expect(calls, [null, 'tok']);

      key.currentState?.refresh();
      await tester.pump();

      // Refresh resolves first
      refreshCompleter.complete((data: (page1Refresh, null), error: null));
      await tester.pumpAndSettle();
      expect(find.text('New2'), findsOneWidget);

      // Stale page 2 resolves after — must not overwrite refresh result
      page2Completer.complete((
        data: (
          [
            _tx(
              name: 'transactions/stale2',
              date: '2026-05-01',
              payee: 'Stale2',
            ),
          ],
          null,
        ),
        error: null,
      ));
      await tester.pumpAndSettle();

      expect(find.text('New2'), findsOneWidget);
      expect(find.text('Stale2'), findsNothing);
    },
  );

  testWidgets(
    'refresh after pagination reloads page 1 and does not immediately fetch page 2',
    (tester) async {
      final page1 = List.generate(
        30,
        (i) => _tx(
          name: 'transactions/p1t$i',
          date: '2026-06-01',
          payee: 'Payee $i',
        ),
      );
      final calls = <String?>[];
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer((inv) async {
        final token = inv.namedArguments[#pageToken] as String?;
        calls.add(token);
        if (token == null) return (data: (page1, 'tok'), error: null);
        return (
          data: (
            [_tx(name: 'transactions/p2t0', date: '2026-05-01', payee: 'Old')],
            null,
          ),
          error: null,
        );
      });

      final key = GlobalKey<TransactionListScreenState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              key: key,
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(calls, [null]);

      await tester.drag(find.byType(ListView), const Offset(0, -5000));
      await tester.pumpAndSettle();
      expect(calls, [null, 'tok']);

      key.currentState?.refresh();
      await tester.pumpAndSettle();
      expect(calls, [null, 'tok', null]);
    },
  );

  testWidgets(
    'pagination failure shows retry footer; tapping retry reuses same page token and footer disappears',
    (tester) async {
      final page1 = List.generate(
        20,
        (i) => _tx(
          name: 'transactions/p1t$i',
          date: '2026-06-01',
          payee: 'Payee $i',
        ),
      );
      final calls = <String?>[];
      var callIndex = 0;
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer((inv) async {
        final token = inv.namedArguments[#pageToken] as String?;
        calls.add(token);
        final i = callIndex++;
        if (i == 0) return (data: (page1, 'tok'), error: null);
        if (i == 1) return (data: null, error: const NetworkError('timeout'));
        return (
          data: (
            [
              _tx(
                name: 'transactions/p2t0',
                date: '2026-05-01',
                payee: 'Recovered',
              ),
            ],
            null,
          ),
          error: null,
        );
      });

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.drag(find.byType(ListView), const Offset(0, -5000));
      await tester.pumpAndSettle();
      // The Retry footer is appended after the last item. Scroll a bit more
      // so the lazy list builds it into the viewport.
      await tester.drag(find.byType(ListView), const Offset(0, -200));
      await tester.pump();
      expect(find.text('Retry'), findsOneWidget);

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(calls, [null, 'tok', 'tok']);
      expect(find.text('Retry'), findsNothing);
    },
  );

  testWidgets(
    'refresh failure on non-empty list shows error banner at top; existing rows still visible',
    (tester) async {
      var callIndex = 0;
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer((_) async {
        final i = callIndex++;
        if (i == 0) return (data: ([_tx()], null), error: null);
        return (data: null, error: const NetworkError('timeout'));
      });

      final key = GlobalKey<TransactionListScreenState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              key: key,
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Migros'), findsOneWidget);

      key.currentState?.refresh();
      await tester.pumpAndSettle();

      expect(find.textContaining('Cannot reach server'), findsOneWidget);
      expect(find.text('Migros'), findsOneWidget);
    },
  );

  testWidgets('transaction with issue shows red left border', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));
    when(
      () => mockRepo.runDoctorIssues(),
    ).thenAnswer((_) async => (data: [_issue('transactions/t1')], error: null));

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(_hasRedLeftBorder(tester), isTrue);
  });

  testWidgets('transaction without issue has no red border', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));
    // setUp already stubs runDoctor to return empty set

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(_hasRedLeftBorder(tester), isFalse);
  });

  testWidgets('doctor is called on initial load without blocking render', (
    tester,
  ) async {
    final doctorCompleter = Completer<_DoctorResult>();
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));
    when(
      () => mockRepo.runDoctorIssues(),
    ).thenAnswer((_) => doctorCompleter.future);

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    // List is rendered before doctor resolves — no red border yet
    expect(find.text('Migros'), findsOneWidget);
    expect(_hasRedLeftBorder(tester), isFalse);

    // Doctor resolves — border appears
    doctorCompleter.complete((data: [_issue('transactions/t1')], error: null));
    await tester.pumpAndSettle();

    expect(_hasRedLeftBorder(tester), isTrue);
  });

  testWidgets('doctor is called again on refresh', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));

    var doctorCallCount = 0;
    when(() => mockRepo.runDoctorIssues()).thenAnswer((_) async {
      doctorCallCount++;
      return (data: <DoctorIssue>[], error: null);
    });

    final key = GlobalKey<TransactionListScreenState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TransactionListScreen(
            key: key,
            transactionRepository: mockRepo,
            accountRepository: mockAccountRepo,
            commodityRepository: mockCommodityRepo,
            queryRepository: mockQueryRepo,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(doctorCallCount, 1);

    key.currentState?.refresh();
    await tester.pumpAndSettle();
    expect(doctorCallCount, 2);
  });

  testWidgets('newly paged-in transactions with issues are marked', (
    tester,
  ) async {
    // 3 items × ~89px each ≈ 267px < 600px viewport, so the fill-viewport
    // post-frame callback auto-loads page 2 without a drag gesture.
    final page1 = List.generate(
      3,
      (i) => _tx(
        name: 'transactions/p1t$i',
        date: '2026-06-01',
        payee: 'Payee $i',
      ),
    );

    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((inv) async {
      final token = inv.namedArguments[#pageToken] as String?;
      if (token == null) return (data: (page1, 'page2'), error: null);
      return (
        data: (
          [_tx(name: 'transactions/p2t0', date: '2026-05-01', payee: 'Coop')],
          null,
        ),
        error: null,
      );
    });

    // Doctor returns the page-2 transaction as having an issue
    when(() => mockRepo.runDoctorIssues()).thenAnswer(
      (_) async => (data: [_issue('transactions/p2t0')], error: null),
    );

    await tester.pumpWidget(buildScreen());
    await tester
        .pumpAndSettle(); // page 2 auto-loads because viewport isn't full

    expect(find.text('Coop'), findsOneWidget);
    expect(_hasRedLeftBorder(tester), isTrue);
  });

  testWidgets('stale doctor result from before refresh is discarded', (
    tester,
  ) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));

    final doctor1Completer = Completer<_DoctorResult>();
    final doctor2Completer = Completer<_DoctorResult>();
    var doctorCallIndex = 0;

    when(() => mockRepo.runDoctorIssues()).thenAnswer((_) {
      final i = doctorCallIndex++;
      if (i == 0) return doctor1Completer.future;
      return doctor2Completer.future;
    });

    final key = GlobalKey<TransactionListScreenState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TransactionListScreen(
            key: key,
            transactionRepository: mockRepo,
            accountRepository: mockAccountRepo,
            commodityRepository: mockCommodityRepo,
            queryRepository: mockQueryRepo,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Trigger refresh — doctor2 starts
    key.currentState?.refresh();
    await tester.pump();

    // Stale doctor1 resolves with an issue — must be discarded
    doctor1Completer.complete((data: [_issue('transactions/t1')], error: null));
    await tester.pump();
    expect(_hasRedLeftBorder(tester), isFalse);

    // doctor2 resolves with no issues
    doctor2Completer.complete((data: <DoctorIssue>[], error: null));
    await tester.pumpAndSettle();
    expect(_hasRedLeftBorder(tester), isFalse);
  });

  testWidgets('tapping a transaction row opens edit screen', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
        filter: any(named: 'filter'),
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Migros'));
    await tester.pumpAndSettle();

    // TransactionEditScreen AppBar title + Save action.
    expect(find.text('Transaction'), findsWidgets);
    expect(find.text('Save'), findsOneWidget);
  });

  testWidgets(
    'returning from edit screen with updated transaction updates the row',
    (tester) async {
      final original = _tx();
      const updated = TransactionResource(
        name: 'transactions/t1',
        transactionDate: '2026-06-18',
        payee: 'Updated Migros',
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

      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer((_) async => (data: ([original], null), error: null));
      when(
        () => mockRepo.updateTransaction(any(), any()),
      ).thenAnswer((_) async => (data: updated, error: null));
      when(
        () => mockRepo.getTransaction('transactions/t1'),
      ).thenAnswer((_) async => (data: updated, error: null));

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      // Open edit screen.
      await tester.tap(find.text('Migros'));
      await tester.pumpAndSettle();

      // Save (postings have accounts from original tx, so validation passes).
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      // List row should show the updated payee.
      expect(find.text('Updated Migros'), findsOneWidget);
      expect(find.text('Migros'), findsNothing);
    },
  );

  // --- Bulk selection tests ---

  group('bulk selection', () {
    late ValueNotifier<Set<String>> selectionNotifier;

    TransactionResource tx2({
      String name = 'transactions/t2',
      String? payee = 'Coop',
    }) => _tx(name: name, payee: payee, narration: null);

    Widget buildScreenWithSelection() {
      selectionNotifier = ValueNotifier<Set<String>>({});
      return MaterialApp(
        home: Scaffold(
          body: TransactionListScreen(
            transactionRepository: mockRepo,
            accountRepository: mockAccountRepo,
            commodityRepository: mockCommodityRepo,
            queryRepository: mockQueryRepo,
            selectionNotifier: selectionNotifier,
          ),
        ),
      );
    }

    setUp(() {
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer((_) async => (data: ([_tx(), tx2()], null), error: null));
      when(
        () => mockRepo.deleteTransaction(any()),
      ).thenAnswer((_) async => null);
      when(() => mockRepo.mergeTransactions(any(), any())).thenAnswer(
        (_) async => (
          data: _tx(name: 'transactions/merged', payee: 'Merged'),
          error: null,
        ),
      );
    });

    testWidgets('long-press activates selection and selects that row', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreenWithSelection());
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Migros'));
      await tester.pumpAndSettle();

      expect(selectionNotifier.value, {'transactions/t1'});
      expect(find.byIcon(Icons.check_circle), findsOneWidget);
    });

    testWidgets('tapping another row in selection mode adds to selection', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreenWithSelection());
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Migros'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Coop'));
      await tester.pumpAndSettle();

      expect(selectionNotifier.value, {'transactions/t1', 'transactions/t2'});
      expect(find.byIcon(Icons.check_circle), findsNWidgets(2));
    });

    testWidgets('tapping a selected row deselects it', (tester) async {
      await tester.pumpWidget(buildScreenWithSelection());
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Migros'));
      await tester.pumpAndSettle();
      expect(selectionNotifier.value, {'transactions/t1'});

      await tester.tap(find.text('Migros'));
      await tester.pumpAndSettle();

      expect(selectionNotifier.value, isEmpty);
    });

    testWidgets('exitSelectionMode clears selection and notifier', (
      tester,
    ) async {
      final key = GlobalKey<TransactionListScreenState>();
      selectionNotifier = ValueNotifier<Set<String>>({});
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              key: key,
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
              selectionNotifier: selectionNotifier,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Migros'));
      await tester.pumpAndSettle();
      expect(selectionNotifier.value, isNotEmpty);

      key.currentState?.exitSelectionMode();
      await tester.pumpAndSettle();

      expect(selectionNotifier.value, isEmpty);
      expect(find.byIcon(Icons.check_circle), findsNothing);
      expect(find.byIcon(Icons.radio_button_unchecked), findsNothing);
    });

    testWidgets('deleteSelected removes rows and clears selection', (
      tester,
    ) async {
      final key = GlobalKey<TransactionListScreenState>();
      selectionNotifier = ValueNotifier<Set<String>>({});
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              key: key,
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
              selectionNotifier: selectionNotifier,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Select both rows.
      await tester.longPress(find.text('Migros'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Coop'));
      await tester.pumpAndSettle();
      expect(selectionNotifier.value.length, 2);

      await key.currentState!.deleteSelected();
      await tester.pumpAndSettle();

      verify(() => mockRepo.deleteTransaction(any())).called(2);
      expect(find.text('Migros'), findsNothing);
      expect(find.text('Coop'), findsNothing);
      expect(selectionNotifier.value, isEmpty);
    });

    testWidgets('deleteSelected on error shows SnackBar and keeps rows', (
      tester,
    ) async {
      when(
        () => mockRepo.deleteTransaction(any()),
      ).thenAnswer((_) async => const NetworkError('timeout'));

      final key = GlobalKey<TransactionListScreenState>();
      selectionNotifier = ValueNotifier<Set<String>>({});
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              key: key,
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
              selectionNotifier: selectionNotifier,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Migros'));
      await tester.pumpAndSettle();

      await key.currentState!.deleteSelected();
      await tester.pumpAndSettle();

      expect(find.byType(SnackBar), findsOneWidget);
      expect(find.text('Migros'), findsOneWidget);
    });

    testWidgets('mergeSelected calls merge + 2 deletes and removes both rows', (
      tester,
    ) async {
      final key = GlobalKey<TransactionListScreenState>();
      selectionNotifier = ValueNotifier<Set<String>>({});
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              key: key,
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
              selectionNotifier: selectionNotifier,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Migros'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Coop'));
      await tester.pumpAndSettle();

      await key.currentState!.mergeSelected();
      await tester.pumpAndSettle();

      verify(() => mockRepo.mergeTransactions(any(), any())).called(1);
      verify(() => mockRepo.deleteTransaction(any())).called(2);
      expect(find.text('Migros'), findsNothing);
      expect(find.text('Coop'), findsNothing);
      expect(find.text('Merged'), findsOneWidget);
      expect(selectionNotifier.value, isEmpty);
    });

    testWidgets('mergeSelected on error shows SnackBar and keeps rows', (
      tester,
    ) async {
      when(() => mockRepo.mergeTransactions(any(), any())).thenAnswer(
        (_) async => (data: null, error: const NetworkError('timeout')),
      );

      final key = GlobalKey<TransactionListScreenState>();
      selectionNotifier = ValueNotifier<Set<String>>({});
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TransactionListScreen(
              key: key,
              transactionRepository: mockRepo,
              accountRepository: mockAccountRepo,
              commodityRepository: mockCommodityRepo,
              queryRepository: mockQueryRepo,
              selectionNotifier: selectionNotifier,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Migros'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Coop'));
      await tester.pumpAndSettle();

      await key.currentState!.mergeSelected();
      await tester.pumpAndSettle();

      expect(find.byType(SnackBar), findsOneWidget);
      expect(find.text('Migros'), findsOneWidget);
      expect(find.text('Coop'), findsOneWidget);
    });
  });
  group('account chart card integration', () {
    void stubList() {
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer((_) async => (data: ([_tx()], null), error: null));
    }

    testWidgets('without an account filter the home balance sheet leads', (
      tester,
    ) async {
      stubList();
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();
      final card = tester.widget<AccountChartCard>(
        find.byType(AccountChartCard),
      );
      expect(card.spec.rootAccounts, ['Assets', 'Liabilities']);
      // No doctor overlay on home views.
      expect(card.assertionIssues, isEmpty);
    });

    testWidgets('chart card appears when the persisted filter has an account', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        'tx_filter_account_name': 'accounts/acc-1',
        'tx_filter_account_display_name': 'Assets:Checking:ZKB',
        'tx_filter_account_is_prefix': false,
      });
      stubList();
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();
      expect(find.byType(AccountChartCard), findsOneWidget);
      // The card and the transaction rows coexist in the same list.
      expect(find.text('Migros'), findsOneWidget);
    });

    testWidgets('bucket tap narrows the shared filter, persists, refreshes', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        'tx_filter_account_name': 'accounts/acc-1',
        'tx_filter_account_display_name': 'Assets:Checking:ZKB',
        'tx_filter_account_is_prefix': false,
      });
      stubList();
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      final card = tester.widget<AccountChartCard>(
        find.byType(AccountChartCard),
      );
      card.onBucketSelected!(DateTime(2026, 3), DateTime(2026, 3, 31));
      await tester.pumpAndSettle();

      final captured = verify(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: captureAny(named: 'filter'),
        ),
      ).captured;
      final narrowed = captured.last as TransactionFilter;
      expect(narrowed.fromDate, DateTime(2026, 3));
      expect(narrowed.toDate, DateTime(2026, 3, 31));
      expect(narrowed.account?.accountName, 'Assets:Checking:ZKB');

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('tx_filter_from_date'), '2026-03-01');
      expect(prefs.getString('tx_filter_to_date'), '2026-03-31');
    });

    testWidgets('selectAccount sets the account on the shared filter', (
      tester,
    ) async {
      stubList();
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      final state = tester.state<TransactionListScreenState>(
        find.byType(TransactionListScreen),
      );
      state.selectAccount(
        const AccountResource(
          name: 'accounts/acc-9',
          accountName: 'Assets:Cash',
          effectiveStartDate: '2020-01-01',
        ),
      );
      await tester.pumpAndSettle();

      final card = tester.widget<AccountChartCard>(
        find.byType(AccountChartCard),
      );
      expect(card.spec.rootAccounts, ['Assets:Cash']);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('tx_filter_account_display_name'), 'Assets:Cash');
    });

    testWidgets(
      'openAccountPicker pushes the account picker and applies the pick',
      (tester) async {
        stubList();
        when(() => mockAccountRepo.getAllAccounts()).thenAnswer(
          (_) async => (
            data: [
              const AccountResource(
                name: 'accounts/acc-9',
                accountName: 'Assets:Cash',
                effectiveStartDate: '2020-01-01',
              ),
            ],
            error: null,
          ),
        );
        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        final state = tester.state<TransactionListScreenState>(
          find.byType(TransactionListScreen),
        );
        state.openAccountPicker();
        await tester.pumpAndSettle();

        expect(find.text('Select Account'), findsOneWidget);
        await tester.tap(find.text('Assets · Cash'));
        await tester.pumpAndSettle();

        expect(
          tester
              .widget<AccountChartCard>(find.byType(AccountChartCard))
              .spec
              .rootAccounts,
          ['Assets:Cash'],
        );
        final prefs = await SharedPreferences.getInstance();
        expect(
          prefs.getString('tx_filter_account_display_name'),
          'Assets:Cash',
        );
      },
    );

    testWidgets(
      'picking a home view in the picker clears the account and switches '
      'the chart',
      (tester) async {
        SharedPreferences.setMockInitialValues({
          'tx_filter_account_name': 'accounts/acc-1',
          'tx_filter_account_display_name': 'Assets:Checking:ZKB',
          'tx_filter_account_is_prefix': false,
        });
        stubList();
        when(
          () => mockAccountRepo.getAllAccounts(),
        ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        final state = tester.state<TransactionListScreenState>(
          find.byType(TransactionListScreen),
        );
        state.openAccountPicker();
        await tester.pumpAndSettle();

        await tester.tap(find.text('Income statement'));
        await tester.pumpAndSettle();

        final card = tester.widget<AccountChartCard>(
          find.byType(AccountChartCard),
        );
        expect(card.spec.rootAccounts, ['Income', 'Expenses']);
        final prefs = await SharedPreferences.getInstance();
        expect(prefs.getString('tx_filter_account_display_name'), isNull);
        expect(prefs.getString('tx_filter_home_view'), 'incomeStatement');
      },
    );

    testWidgets('bucket tap on the home chart narrows dates and stays home', (
      tester,
    ) async {
      stubList();
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      final card = tester.widget<AccountChartCard>(
        find.byType(AccountChartCard),
      );
      expect(card.spec.rootAccounts, ['Assets', 'Liabilities']);
      card.onBucketSelected!(DateTime(2026, 3), DateTime(2026, 3, 31));
      await tester.pumpAndSettle();

      final narrowed = tester.widget<AccountChartCard>(
        find.byType(AccountChartCard),
      );
      // Still the home view — only the date range narrowed.
      expect(narrowed.spec.rootAccounts, ['Assets', 'Liabilities']);
      expect(narrowed.fromDate, DateTime(2026, 3));
      expect(narrowed.toDate, DateTime(2026, 3, 31));
    });

    testWidgets('chart card shows an empty-state row when no transactions', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        'tx_filter_account_name': 'accounts/acc-1',
        'tx_filter_account_display_name': 'Assets:Checking:ZKB',
        'tx_filter_account_is_prefix': false,
      });
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer(
        (_) async => (data: (<TransactionResource>[], null), error: null),
      );
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();
      expect(find.byType(AccountChartCard), findsOneWidget);
      expect(find.text('No transactions in range'), findsOneWidget);
    });

    testWidgets(
      "a load error never shows alongside 'No transactions in range'",
      (tester) async {
        SharedPreferences.setMockInitialValues({
          'tx_filter_account_name': 'accounts/acc-1',
          'tx_filter_account_display_name': 'Assets:Checking:ZKB',
          'tx_filter_account_is_prefix': false,
        });
        when(
          () => mockRepo.listTransactions(
            pageSize: any(named: 'pageSize'),
            pageToken: any(named: 'pageToken'),
            filter: any(named: 'filter'),
          ),
        ).thenAnswer(
          (_) async => (data: null, error: const NetworkError('down')),
        );

        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        expect(find.byType(AccountChartCard), findsOneWidget);
        expect(find.byType(ErrorBanner), findsOneWidget);
        expect(find.text('No transactions in range'), findsNothing);
      },
    );

    testWidgets('editing a transaction bumps the chart refresh tick', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        'tx_filter_account_name': 'accounts/acc-1',
        'tx_filter_account_display_name': 'Assets:Bank:Checking',
        'tx_filter_account_is_prefix': false,
      });
      final original = _tx();
      const updated = TransactionResource(
        name: 'transactions/t1',
        transactionDate: '2026-06-18',
        payee: 'Updated Migros',
        narration: 'Groceries',
        postings: [
          PostingResource(
            account: 'accounts/acc_checking',
            accountName: 'Assets:Bank:Checking',
            units: MoneyValue(amount: '-99.00', symbol: 'CHF'),
          ),
          PostingResource(
            account: 'accounts/acc_food',
            accountName: 'Expenses:Food',
            units: MoneyValue(amount: '99.00', symbol: 'CHF'),
          ),
        ],
      );
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
          filter: any(named: 'filter'),
        ),
      ).thenAnswer((_) async => (data: ([original], null), error: null));
      when(
        () => mockRepo.updateTransaction(any(), any()),
      ).thenAnswer((_) async => (data: updated, error: null));
      when(
        () => mockRepo.getTransaction('transactions/t1'),
      ).thenAnswer((_) async => (data: updated, error: null));

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();
      final before = tester
          .widget<AccountChartCard>(find.byType(AccountChartCard))
          .refreshTick;

      await tester.tap(find.text('Migros'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      final after = tester
          .widget<AccountChartCard>(find.byType(AccountChartCard))
          .refreshTick;
      expect(after, greaterThan(before));
    });

    testWidgets(
      'a same-count assertion detail change (e.g. a shrinking diff) still refreshes',
      (tester) async {
        SharedPreferences.setMockInitialValues({
          'tx_filter_account_name': 'accounts/acc-1',
          'tx_filter_account_display_name': 'Assets:Checking:ZKB',
          'tx_filter_account_is_prefix': false,
        });
        when(
          () => mockRepo.listTransactions(
            pageSize: any(named: 'pageSize'),
            pageToken: any(named: 'pageToken'),
            filter: any(named: 'filter'),
          ),
        ).thenAnswer((_) async => (data: ([_tx()], null), error: null));

        DoctorIssue assertionIssue(String diff) => DoctorIssue(
          target: 'balanceAssertions/ba-1',
          code: DoctorIssue.balanceAssertionFailed,
          targetSummary: const {
            'date': '2026-01-05',
            'account': 'Assets:Checking:ZKB',
          },
          details: {'diff': diff},
        );

        when(() => mockRepo.runDoctorIssues()).thenAnswer(
          (_) async => (data: [assertionIssue('-50.00')], error: null),
        );
        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<AccountChartCard>(find.byType(AccountChartCard))
              .assertionIssues
              .single
              .details['diff'],
          '-50.00',
        );

        // Same count (1), different diff amount — must still propagate.
        when(() => mockRepo.runDoctorIssues()).thenAnswer(
          (_) async => (data: [assertionIssue('-10.00')], error: null),
        );
        final state = tester.state<TransactionListScreenState>(
          find.byType(TransactionListScreen),
        );
        state.refresh();
        await tester.pumpAndSettle();

        expect(
          tester
              .widget<AccountChartCard>(find.byType(AccountChartCard))
              .assertionIssues
              .single
              .details['diff'],
          '-10.00',
        );
      },
    );
  });
}
