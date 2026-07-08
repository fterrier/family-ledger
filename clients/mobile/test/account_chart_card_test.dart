import 'dart:async';

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/doctor_issue.dart';
import 'package:family_ledger_mobile/models/query_result.dart';
import 'package:family_ledger_mobile/repositories/query_repository.dart';
import 'package:family_ledger_mobile/widgets/account_chart_card.dart';

class MockQueryRepository extends Mock implements QueryRepository {}

const _checking = AccountResource(
  name: 'accounts/acc-1',
  accountName: 'Assets:Checking:ZKB',
  effectiveStartDate: '2020-01-01',
);

const _groceries = AccountResource(
  name: 'accounts/acc-2',
  accountName: 'Expenses:Groceries',
  effectiveStartDate: '2020-01-01',
);

const _card = AccountResource(
  name: 'accounts/acc-3',
  accountName: 'Liabilities:Cembra:Mastercard',
  effectiveStartDate: '2020-01-01',
);

QueryResult _inventoryResult(List<List<Object?>> rows) => QueryResult(
  columns: const [
    QueryColumnDef(name: 'y', type: 'int'),
    QueryColumnDef(name: 'm', type: 'int'),
    QueryColumnDef(name: 'bal', type: 'inventory'),
  ],
  rows: rows,
  warnings: const [],
);

List<QueryAmount> _inv(Map<String, String> amounts) => [
  for (final e in amounts.entries)
    QueryAmount(number: e.value, currency: e.key),
];

void main() {
  late MockQueryRepository repo;

  setUp(() {
    repo = MockQueryRepository();
  });

  // Defaults to a ~1-year span so the card requests monthly buckets,
  // matching the monthly-shaped fixtures below.
  Widget build(
    AccountResource account, {
    DateTime? from,
    DateTime? to,
    void Function(DateTime, DateTime)? onBucketSelected,
    bool showsLastImportHint = false,
    List<DoctorIssue> assertionIssues = const [],
  }) => MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: AccountChartCard(
          queryRepository: repo,
          account: account,
          fromDate: from ?? DateTime(2025, 7),
          toDate: to ?? DateTime(2026, 6, 30),
          onBucketSelected: onBucketSelected,
          showsLastImportHint: showsLastImportHint,
          assertionIssues: assertionIssues,
        ),
      ),
    ),
  );

  testWidgets('asset account renders a line with balance and delta', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2025,
            7,
            _inv({'CHF': '5800'}),
          ],
          [
            2025,
            8,
            _inv({'CHF': '4000'}),
          ],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    expect(find.byType(LineChart), findsOneWidget);
    expect(find.text('4,000.00 CHF'), findsOneWidget);
    expect(find.textContaining('-1,800.00'), findsOneWidget);
    verify(() => repo.run(any())).called(1);
  });

  testWidgets('liability balances keep their raw negative sign', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2026,
            1,
            _inv({'CHF': '-3200'}),
          ],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_card));
    await tester.pumpAndSettle();

    expect(find.text('-3,200.00 CHF'), findsOneWidget);
    expect(find.byType(LineChart), findsOneWidget);
  });

  testWidgets('expense account renders bars with the range total', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2025,
            7,
            _inv({'CHF': '200'}),
          ],
          [
            2025,
            8,
            _inv({'CHF': '300'}),
          ],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_groceries));
    await tester.pumpAndSettle();

    expect(find.byType(BarChart), findsOneWidget);
    expect(find.text('500.00 CHF'), findsOneWidget);
  });

  testWidgets(
    'multi-currency defaults to converted view with chips and warnings',
    (tester) async {
      when(() => repo.run(any(that: contains('convert(')))).thenAnswer(
        (_) async => (
          data: const QueryResult(
            columns: [
              QueryColumnDef(name: 'y', type: 'int'),
              QueryColumnDef(name: 'm', type: 'int'),
              QueryColumnDef(name: 'bal', type: 'amount'),
            ],
            rows: [
              [2025, 8, QueryAmount(number: '4040', currency: 'CHF')],
            ],
            warnings: [
              QueryWarningInfo(
                code: 'missing_price',
                message: 'No CHF price for USD on or before 2025-08-31.',
              ),
            ],
          ),
          error: null,
        ),
      );
      when(() => repo.run(any(that: isNot(contains('convert('))))).thenAnswer(
        (_) async => (
          data: _inventoryResult([
            [
              2025,
              8,
              _inv({'CHF': '4000', 'USD': '50'}),
            ],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      // Converted view by default: two queries, converted headline, chips.
      expect(find.text('4,040.00 CHF'), findsOneWidget);
      expect(find.text('CHF'), findsOneWidget);
      expect(find.text('USD'), findsOneWidget);
      expect(find.text('≈ CHF'), findsOneWidget);
      verify(() => repo.run(any())).called(2);

      // Warning badge is visible; tapping it lists the warning.
      expect(find.text('1'), findsOneWidget);
      await tester.tap(find.text('1'));
      await tester.pumpAndSettle();
      expect(find.text('Price warnings'), findsOneWidget);
      expect(
        find.text('No CHF price for USD on or before 2025-08-31.'),
        findsOneWidget,
      );
      await tester.tapAt(const Offset(10, 10)); // dismiss sheet
      await tester.pumpAndSettle();

      // Picking a specific currency re-projects without a new query.
      await tester.tap(find.text('USD'));
      await tester.pumpAndSettle();
      expect(find.text('50.00 USD'), findsOneWidget);
      verifyNever(() => repo.run(any(that: contains("currency = 'USD'"))));
    },
  );

  testWidgets('error state offers retry', (tester) async {
    when(
      () => repo.run(any()),
    ).thenAnswer((_) async => (data: null, error: const AuthError()));

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    expect(find.text('Retry'), findsOneWidget);

    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2025,
            7,
            _inv({'CHF': '100'}),
          ],
        ]),
        error: null,
      ),
    );
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text('100.00 CHF'), findsOneWidget);
  });

  testWidgets('empty series shows a hint instead of a chart', (tester) async {
    when(
      () => repo.run(any()),
    ).thenAnswer((_) async => (data: _inventoryResult([]), error: null));

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    expect(find.text('No data in range'), findsOneWidget);
    expect(find.byType(LineChart), findsNothing);
  });

  testWidgets('last-import hint appears when the filter toggle is on', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2025,
            7,
            _inv({'CHF': '100'}),
          ],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking, showsLastImportHint: true));
    await tester.pumpAndSettle();

    expect(find.text("Chart ignores the 'last import' filter"), findsOneWidget);
  });
  testWidgets('assertion failures render a badge, band, and details sheet', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2025,
            7,
            _inv({'CHF': '5800'}),
          ],
          [
            2025,
            8,
            _inv({'CHF': '4000'}),
          ],
        ]),
        error: null,
      ),
    );
    const issue = DoctorIssue(
      target: 'balanceAssertions/ba-1',
      code: DoctorIssue.balanceAssertionFailed,
      targetSummary: {'date': '2025-08-15', 'account': 'Assets:Checking:ZKB'},
      details: {
        'symbol': 'CHF',
        'asserted_amount': '118638.58',
        'actual_amount': '118640.08',
        'diff': '-1.50',
      },
    );

    await tester.pumpWidget(build(_checking, assertionIssues: [issue]));
    await tester.pumpAndSettle();

    // Red band over the August bucket (index 1 of Jul/Aug).
    final chart = tester.widget<LineChart>(find.byType(LineChart));
    final bands = chart.data.rangeAnnotations.verticalRangeAnnotations;
    expect(bands, hasLength(1));
    expect(bands.single.x1, 0.5);

    // Badge opens the failure list with the amounts.
    expect(find.text('1'), findsOneWidget);
    await tester.tap(find.text('1'));
    await tester.pumpAndSettle();
    expect(find.text('Balance assertion failures'), findsOneWidget);
    expect(
      find.text('expected 118638.58, actual 118640.08 (Δ -1.50 CHF)'),
      findsOneWidget,
    );
  });
  testWidgets(
    'multi-currency shows a placeholder while the converted query is pending '
    '(regression: fl_chart crashed on the empty transient projection)',
    (tester) async {
      final convertedCompleter =
          Completer<({QueryResult? data, ApiError? error})>();
      when(
        () => repo.run(any(that: contains('convert('))),
      ).thenAnswer((_) => convertedCompleter.future);
      when(() => repo.run(any(that: isNot(contains('convert('))))).thenAnswer(
        (_) async => (
          data: _inventoryResult([
            [
              2025,
              8,
              _inv({'CHF': '4000', 'USD': '50'}),
            ],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pump(); // base query resolves
      await tester.pump(); // frame with converted projection still empty

      // No crash; chart slot shows a spinner instead of an empty LineChart.
      expect(tester.takeException(), isNull);
      expect(find.byType(LineChart), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      convertedCompleter.complete((
        data: const QueryResult(
          columns: [
            QueryColumnDef(name: 'y', type: 'int'),
            QueryColumnDef(name: 'm', type: 'int'),
            QueryColumnDef(name: 'bal', type: 'amount'),
          ],
          rows: [
            [2025, 8, QueryAmount(number: '4040', currency: 'CHF')],
          ],
          warnings: [],
        ),
        error: null,
      ));
      await tester.pumpAndSettle();
      expect(find.byType(LineChart), findsOneWidget);
      expect(find.text('4,040.00 CHF'), findsOneWidget);
    },
  );

  testWidgets('flat balance line renders without a zero-interval crash', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2025,
            7,
            _inv({'CHF': '1000'}),
          ],
          [
            2025,
            10,
            _inv({'CHF': '1000'}),
          ],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.byType(LineChart), findsOneWidget);
  });
}
