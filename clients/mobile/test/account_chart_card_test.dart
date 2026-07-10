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

QueryResult _dailyInventoryResult(List<List<Object?>> rows) => QueryResult(
  columns: const [
    QueryColumnDef(name: 'y', type: 'int'),
    QueryColumnDef(name: 'm', type: 'int'),
    QueryColumnDef(name: 'd', type: 'int'),
    QueryColumnDef(name: 'bal', type: 'inventory'),
  ],
  rows: rows,
  warnings: const [],
);

QueryResult _yearlyInventoryResult(List<List<Object?>> rows) => QueryResult(
  columns: const [
    QueryColumnDef(name: 'y', type: 'int'),
    QueryColumnDef(name: 'bal', type: 'inventory'),
  ],
  rows: rows,
  warnings: const [],
);

List<QueryAmount> _inv(Map<String, String> amounts) => [
  for (final e in amounts.entries)
    QueryAmount(number: e.value, currency: e.key),
];

List<Object?> _dailyRow(DateTime d, String value) => [
  d.year,
  d.month,
  d.day,
  _inv({'CHF': value}),
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
    String defaultCurrency = 'CHF',
    String? currencyFilter,
    int refreshTick = 0,
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
          defaultCurrency: defaultCurrency,
          currencyFilter: currencyFilter,
          refreshTick: refreshTick,
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
    'multi-currency defaults to converted view with no toggle, and warnings',
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

      // Converted view by default: two queries, converted headline, no
      // per-currency chips or toggle (multi-currency has no single "unit"
      // to fall back to).
      expect(find.text('4,040.00 CHF'), findsOneWidget);
      expect(find.text('CHF'), findsNothing);
      expect(find.text('USD'), findsNothing);
      expect(find.text('≈ CHF'), findsNothing);
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
    },
  );

  testWidgets(
    'a failed converted query only breaks the chart slot, not the whole card',
    (tester) async {
      when(() => repo.run(any(that: contains('convert(')))).thenAnswer(
        (_) async => (data: null, error: const NetworkError('timed out')),
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

      // Header/headline stay driven by the valid base series; only the
      // chart slot shows the error + retry.
      expect(find.text('Assets · Checking · ZKB'), findsOneWidget);
      expect(find.text('timed out'), findsOneWidget);
      expect(find.byType(LineChart), findsNothing);
    },
  );

  testWidgets('retrying a failed converted query recovers the chart', (
    tester,
  ) async {
    var convertedCalls = 0;
    when(() => repo.run(any(that: contains('convert(')))).thenAnswer((_) async {
      convertedCalls++;
      if (convertedCalls == 1) {
        return (data: null, error: const NetworkError('timed out'));
      }
      return (
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
      );
    });
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
    expect(find.text('timed out'), findsOneWidget);

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(find.text('4,040.00 CHF'), findsOneWidget);
    expect(find.byType(LineChart), findsOneWidget);
  });

  testWidgets(
    'changing the default currency re-fetches the converted view without '
    'mislabeling stale values',
    (tester) async {
      when(() => repo.run(any(that: contains("'CHF'")))).thenAnswer(
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
            warnings: [],
          ),
          error: null,
        ),
      );
      when(() => repo.run(any(that: contains("'USD'")))).thenAnswer(
        (_) async => (
          data: const QueryResult(
            columns: [
              QueryColumnDef(name: 'y', type: 'int'),
              QueryColumnDef(name: 'm', type: 'int'),
              QueryColumnDef(name: 'bal', type: 'amount'),
            ],
            rows: [
              [2025, 8, QueryAmount(number: '4750', currency: 'USD')],
            ],
            warnings: [],
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
              _inv({'CHF': '4000', 'EUR': '50'}),
            ],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();
      expect(find.text('4,040.00 CHF'), findsOneWidget);

      await tester.pumpWidget(build(_checking, defaultCurrency: 'USD'));
      await tester.pumpAndSettle();

      // Re-fetched with the new target and labeled/valued consistently —
      // never '4,040.00 USD' (old CHF number under the new label).
      expect(find.text('4,750.00 USD'), findsOneWidget);
      expect(find.text('4,040.00 USD'), findsNothing);
    },
  );

  testWidgets(
    'single-currency series shows the raw value with no Converted toggle',
    (tester) async {
      when(() => repo.run(any())).thenAnswer(
        (_) async => (
          data: _inventoryResult([
            [
              2025,
              7,
              _inv({'CHF': '5800'}),
            ],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      expect(find.text('≈ CHF'), findsNothing);
      expect(find.text('5,800.00 CHF'), findsOneWidget);
      verify(() => repo.run(any())).called(1); // no converted fetch at all
    },
  );

  testWidgets('currencyFilter scopes the query to that commodity', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2025,
            7,
            _inv({'USD': '100'}),
          ],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking, currencyFilter: 'USD'));
    await tester.pumpAndSettle();

    verify(() => repo.run(any(that: contains("currency = 'USD'")))).called(1);
  });

  testWidgets('changing the currencyFilter re-queries the chart', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          [
            2025,
            7,
            _inv({'USD': '100'}),
          ],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking, currencyFilter: 'USD'));
    await tester.pumpAndSettle();
    verify(() => repo.run(any())).called(1);

    await tester.pumpWidget(build(_checking, currencyFilter: 'EUR'));
    await tester.pumpAndSettle();

    verify(() => repo.run(any(that: contains("currency = 'EUR'")))).called(1);
  });

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

  // Matches a rendered "MMM yy" bucket label (e.g. "Jan 25"), regardless of
  // exactly which glyph widths the test font uses.
  final monthLabelFinder = find.byWidgetPredicate(
    (w) => w is Text && RegExp(r'^[A-Z][a-z]{2} \d{2}$').hasMatch(w.data ?? ''),
  );

  Future<void> pumpTwelveMonths(WidgetTester tester) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _inventoryResult([
          for (var m = 1; m <= 12; m++)
            [
              2025,
              m,
              _inv({'CHF': '${100 + m}'}),
            ],
        ]),
        error: null,
      ),
    );
    // Uses the expense (bar-chart) account rather than checking: at very
    // narrow widths the balance card's delta chip overflows its header row
    // regardless of the axis-label fix under test here.
    await tester.pumpWidget(
      build(_groceries, from: DateTime(2025), to: DateTime(2025, 12, 31)),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('granularity chip row offers Day, Month, and Year', (
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

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    expect(find.text('Day'), findsOneWidget);
    expect(find.text('Month'), findsOneWidget);
    expect(find.text('Year'), findsOneWidget);
  });

  testWidgets('tapping Day re-queries with daily buckets', (tester) async {
    when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
      (_) async => (
        data: _dailyInventoryResult([
          [
            2025,
            7,
            15,
            _inv({'CHF': '150'}),
          ],
        ]),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
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

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();
    verifyNever(() => repo.run(any(that: contains('day(date)'))));

    await tester.tap(find.text('Day'));
    await tester.pumpAndSettle();

    verify(() => repo.run(any(that: contains('day(date)')))).called(1);
    expect(find.text('150.00 CHF'), findsOneWidget);
  });

  testWidgets('tapping Year re-queries with only a year bucket', (
    tester,
  ) async {
    when(() => repo.run(any(that: contains('month(date)')))).thenAnswer(
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
    when(() => repo.run(any(that: isNot(contains('month(date)'))))).thenAnswer(
      (_) async => (
        data: _yearlyInventoryResult([
          [
            2025,
            _inv({'CHF': '999'}),
          ],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Year'));
    await tester.pumpAndSettle();

    verify(() => repo.run(any(that: isNot(contains('month(date)'))))).called(1);
    expect(find.text('999.00 CHF'), findsOneWidget);
  });

  testWidgets(
    'granularity choice resets to the span-derived default when the date '
    'range changes',
    (tester) async {
      when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
        (_) async => (
          data: _dailyInventoryResult([
            [
              2025,
              7,
              15,
              _inv({'CHF': '150'}),
            ],
          ]),
          error: null,
        ),
      );
      when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
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

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Day'));
      await tester.pumpAndSettle();
      verify(() => repo.run(any(that: contains('day(date)')))).called(1);

      // A new date range is a new view: the daily override doesn't survive
      // it — back to the span-derived default (monthly for a ~1yr span),
      // not a second daily query for the new range. (The prior daily call
      // was already consumed by the `verify` above, so any further match
      // here would have to be a new one.)
      await tester.pumpWidget(
        build(_checking, from: DateTime(2024), to: DateTime(2024, 12, 31)),
      );
      await tester.pumpAndSettle();

      verifyNever(() => repo.run(any(that: contains('day(date)'))));
    },
  );

  testWidgets(
    'granularity choice survives a refreshTick-only change (e.g. editing an '
    'unrelated transaction)',
    (tester) async {
      when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
        (_) async => (
          data: _dailyInventoryResult([
            [
              2025,
              7,
              15,
              _inv({'CHF': '150'}),
            ],
          ]),
          error: null,
        ),
      );
      when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
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

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Day'));
      await tester.pumpAndSettle();
      verify(() => repo.run(any(that: contains('day(date)')))).called(1);

      // Same account and date range, only refreshTick bumped (this is what
      // happens when e.g. an unrelated transaction is edited) — the data
      // reloads, but the user's "Day" pick must survive.
      await tester.pumpWidget(build(_checking, refreshTick: 1));
      await tester.pumpAndSettle();

      verify(() => repo.run(any(that: contains('day(date)')))).called(1);
    },
  );

  testWidgets('granularity choice survives a currencyFilter-only change', (
    tester,
  ) async {
    when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
      (_) async => (
        data: _dailyInventoryResult([
          [
            2025,
            7,
            15,
            _inv({'CHF': '150'}),
          ],
        ]),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
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

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Day'));
    await tester.pumpAndSettle();
    verify(() => repo.run(any(that: contains('day(date)')))).called(1);

    // Same account and date range, only the commodity filter narrowed —
    // the data reloads, but the user's "Day" pick must survive.
    await tester.pumpWidget(build(_checking, currencyFilter: 'CHF'));
    await tester.pumpAndSettle();

    verify(() => repo.run(any(that: contains('day(date)')))).called(1);
  });

  testWidgets('wide card renders every month label when they all fit', (
    tester,
  ) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    tester.view.physicalSize = const Size(4000, 800);
    tester.view.devicePixelRatio = 1.0;

    await pumpTwelveMonths(tester);

    expect(monthLabelFinder, findsNWidgets(12));
  });

  testWidgets(
    'narrow card thins out month labels instead of overlapping them',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1.0;

      await pumpTwelveMonths(tester);

      // All 12 buckets collide at this width — labels get thinned rather
      // than rendered on top of each other.
      expect(monthLabelFinder.evaluate().length, lessThan(12));
    },
  );

  testWidgets('bar width shrinks so many daily buckets don\'t overlap', (
    tester,
  ) async {
    final start = DateTime(2025);
    when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
      (_) async => (
        data: _dailyInventoryResult([
          for (var i = 0; i < 100; i++)
            _dailyRow(start.add(Duration(days: i)), '10'),
        ]),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
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

    await tester.pumpWidget(build(_groceries));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Day'));
    await tester.pumpAndSettle();

    final bar = tester.widget<BarChart>(find.byType(BarChart));
    final rodWidth = bar.data.barGroups.first.barRods.first.width;
    final plotWidth = tester.getSize(find.byType(BarChart)).width - 52;

    // 100 groups spread evenly across the plot: each bar must fit its
    // share of the width or fl_chart's spaceEvenly layout packs them
    // into overlapping slivers.
    expect(rodWidth, lessThanOrEqualTo(plotWidth / 100));
  });

  testWidgets(
    'bar width has no lower-bound floor, so total width still fits the '
    'plot at extreme bucket counts (regression: a floor previously forced '
    'the total past the plot, reintroducing overlap)',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1.0;

      const bucketCount = 500;
      final start = DateTime(2023);
      when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
        (_) async => (
          data: _dailyInventoryResult([
            for (var i = 0; i < bucketCount; i++)
              _dailyRow(start.add(Duration(days: i)), '10'),
          ]),
          error: null,
        ),
      );
      when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
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

      await tester.pumpWidget(build(_groceries));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Day'));
      await tester.pumpAndSettle();

      final bar = tester.widget<BarChart>(find.byType(BarChart));
      final rodWidth = bar.data.barGroups.first.barRods.first.width;
      final plotWidth = tester.getSize(find.byType(BarChart)).width - 52;

      // The combined width of all 500 bars must still fit the plot — not
      // just each bar individually fitting its own fair share. A naive
      // minimum-width floor (the pre-fix code clamped up to 2.0px) would
      // force 500 * 2.0 = 1000px into a ~150px plot at this width.
      expect(rodWidth * bucketCount, lessThanOrEqualTo(plotWidth));
    },
  );

  testWidgets(
    'bar width grows for a handful of yearly buckets instead of staying a '
    'sliver',
    (tester) async {
      when(() => repo.run(any(that: contains('month(date)')))).thenAnswer(
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
      when(
        () => repo.run(any(that: isNot(contains('month(date)')))),
      ).thenAnswer(
        (_) async => (
          data: _yearlyInventoryResult([
            [
              2023,
              _inv({'CHF': '100'}),
            ],
            [
              2024,
              _inv({'CHF': '150'}),
            ],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_groceries));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Year'));
      await tester.pumpAndSettle();

      final bar = tester.widget<BarChart>(find.byType(BarChart));
      final rodWidth = bar.data.barGroups.first.barRods.first.width;

      // Only 2 buckets in a wide plot: the old fixed 8px reads as a sliver
      // against the available space; it should scale up noticeably.
      expect(rodWidth, greaterThan(8.0));
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
