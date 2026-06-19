import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/posting.dart';
import 'package:family_ledger_mobile/models/transaction.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_list_screen.dart';

typedef _DoctorResult = ({Set<String>? data, ApiError? error});

// Finds the red issue-indicator bar (a ColoredBox painted with the issue color).
bool _hasRedLeftBorder(WidgetTester tester) {
  return tester
      .widgetList<ColoredBox>(find.byType(ColoredBox))
      .any((w) => w.color == const Color(0xFFFF3B30));
}

class MockTransactionRepository extends Mock implements TransactionRepository {}

typedef _ListResult = ({
  (List<TransactionResource>, String?)? data,
  ApiError? error,
});

TransactionResource _tx({
  String name = 'transactions/t1',
  String date = '2026-06-18',
  String? payee = 'Migros',
  String? narration = 'Groceries',
  String amount = '-42.50',
  String symbol = 'CHF',
}) => TransactionResource(
  name: name,
  transactionDate: date,
  payee: payee,
  narration: narration,
  postings: [
    PostingResource(
      account: 'accounts/acc_checking',
      units: MoneyValue(amount: amount, symbol: symbol),
    ),
  ],
);

void main() {
  late MockTransactionRepository mockRepo;

  setUp(() {
    mockRepo = MockTransactionRepository();
    // Default: doctor returns no issues (keeps existing tests unaffected)
    when(
      () => mockRepo.runDoctor(),
    ).thenAnswer((_) async => (data: <String>{}, error: null));
  });

  Widget buildScreen() => MaterialApp(
    home: Scaffold(
      body: TransactionListScreen(transactionRepository: mockRepo),
    ),
  );

  testWidgets('shows loading indicator while fetching', (tester) async {
    final completer = Completer<_ListResult>();
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
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
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(find.text('Migros'), findsOneWidget);
    expect(find.text('Groceries'), findsOneWidget);
    expect(find.text('-42.50 CHF'), findsOneWidget);
    expect(find.text('Jun 18'), findsOneWidget);
  });

  testWidgets('shows "No transactions yet" when list is empty', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
      ),
    ).thenAnswer(
      (_) async => (data: (<TransactionResource>[], null), error: null),
    );

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(find.text('No transactions yet'), findsOneWidget);
  });

  testWidgets('shows error banner on load failure', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
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
      (i) => _tx(
        name: 'transactions/t$i',
        date: '2026-06-01',
        payee: 'Payee $i',
        narration: null,
      ),
    );

    final calls = <String?>[];
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
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
                    narration: null,
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
        narration: null,
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
        [
          _tx(
            name: 'transactions/stale',
            date: '2026-05-01',
            payee: 'Stale',
            narration: null,
          ),
        ],
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
          narration: null,
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
              narration: null,
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
          narration: null,
        ),
      );
      final calls = <String?>[];
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
        ),
      ).thenAnswer((inv) async {
        final token = inv.namedArguments[#pageToken] as String?;
        calls.add(token);
        if (token == null) return (data: (page1, 'tok'), error: null);
        return (
          data: (
            [
              _tx(
                name: 'transactions/p2t0',
                date: '2026-05-01',
                payee: 'Old',
                narration: null,
              ),
            ],
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
          narration: null,
        ),
      );
      final calls = <String?>[];
      var callIndex = 0;
      when(
        () => mockRepo.listTransactions(
          pageSize: any(named: 'pageSize'),
          pageToken: any(named: 'pageToken'),
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
                narration: null,
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
            body: TransactionListScreen(transactionRepository: mockRepo),
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
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));
    when(
      () => mockRepo.runDoctor(),
    ).thenAnswer((_) async => (data: {'transactions/t1'}, error: null));

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    expect(_hasRedLeftBorder(tester), isTrue);
  });

  testWidgets('transaction without issue has no red border', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
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
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));
    when(() => mockRepo.runDoctor()).thenAnswer((_) => doctorCompleter.future);

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();

    // List is rendered before doctor resolves — no red border yet
    expect(find.text('Migros'), findsOneWidget);
    expect(_hasRedLeftBorder(tester), isFalse);

    // Doctor resolves — border appears
    doctorCompleter.complete((data: {'transactions/t1'}, error: null));
    await tester.pumpAndSettle();

    expect(_hasRedLeftBorder(tester), isTrue);
  });

  testWidgets('doctor is called again on refresh', (tester) async {
    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));

    var doctorCallCount = 0;
    when(() => mockRepo.runDoctor()).thenAnswer((_) async {
      doctorCallCount++;
      return (data: <String>{}, error: null);
    });

    final key = GlobalKey<TransactionListScreenState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TransactionListScreen(
            key: key,
            transactionRepository: mockRepo,
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
        narration: null,
      ),
    );

    when(
      () => mockRepo.listTransactions(
        pageSize: any(named: 'pageSize'),
        pageToken: any(named: 'pageToken'),
      ),
    ).thenAnswer((inv) async {
      final token = inv.namedArguments[#pageToken] as String?;
      if (token == null) return (data: (page1, 'page2'), error: null);
      return (
        data: (
          [
            _tx(
              name: 'transactions/p2t0',
              date: '2026-05-01',
              payee: 'Coop',
              narration: null,
            ),
          ],
          null,
        ),
        error: null,
      );
    });

    // Doctor returns the page-2 transaction as having an issue
    when(
      () => mockRepo.runDoctor(),
    ).thenAnswer((_) async => (data: {'transactions/p2t0'}, error: null));

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
      ),
    ).thenAnswer((_) async => (data: ([_tx()], null), error: null));

    final doctor1Completer = Completer<_DoctorResult>();
    final doctor2Completer = Completer<_DoctorResult>();
    var doctorCallIndex = 0;

    when(() => mockRepo.runDoctor()).thenAnswer((_) {
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
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Trigger refresh — doctor2 starts
    key.currentState?.refresh();
    await tester.pump();

    // Stale doctor1 resolves with an issue — must be discarded
    doctor1Completer.complete((data: {'transactions/t1'}, error: null));
    await tester.pump();
    expect(_hasRedLeftBorder(tester), isFalse);

    // doctor2 resolves with no issues
    doctor2Completer.complete((data: <String>{}, error: null));
    await tester.pumpAndSettle();
    expect(_hasRedLeftBorder(tester), isFalse);
  });
}
