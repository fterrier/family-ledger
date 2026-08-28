import 'dart:async';

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/core/home_view.dart';
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

// Every chart query is requested pre-converted to a single currency (see
// AccountChartCard._seriesQuery), so every fixture below is amount-shaped
// (one QueryAmount cell per bucket) rather than the multi-currency
// inventory shape the raw (non-converted) query used to return.
// keyCount selects how many leading bucket-key columns precede `bal`: 1 for
// yearly (y), 2 for monthly (y, m — the default), 3 for daily (y, m, d).
QueryResult _amountResult(List<List<Object?>> rows, {int keyCount = 2}) {
  const keyColumns = [
    QueryColumnDef(name: 'y', type: 'int'),
    QueryColumnDef(name: 'm', type: 'int'),
    QueryColumnDef(name: 'd', type: 'int'),
  ];
  return QueryResult(
    columns: [
      ...keyColumns.take(keyCount),
      const QueryColumnDef(name: 'bal', type: 'amount'),
    ],
    rows: rows,
    warnings: const [],
  );
}

QueryAmount _amt(String value, [String currency = 'CHF']) =>
    QueryAmount(number: value, currency: currency);

List<Object?> _dailyRow(DateTime d, String value) => [
  d.year,
  d.month,
  d.day,
  _amt(value),
];

// value() shows up in both the series query and (when Market is selected)
// the always-yearly opening-balance query — 'FROM CLOSE ON' is unique to
// the latter, so it's the discriminator between the two.
final Matcher _seriesValueQuery = allOf(
  contains('value('),
  isNot(contains('FROM CLOSE ON')),
);
final Matcher _seriesCostQuery = allOf(
  isNot(contains('value(')),
  isNot(contains('FROM CLOSE ON')),
);

void main() {
  late MockQueryRepository repo;

  setUp(() {
    repo = MockQueryRepository();
  });

  // Defaults to a ~1-year span so the card requests monthly buckets,
  // matching the monthly-shaped fixtures below.
  Widget buildSpec(
    ChartSpec spec, {
    DateTime? from,
    DateTime? to,
    void Function(DateTime, DateTime)? onBucketSelected,
    ValueChanged<ApiError?>? onError,
    bool showsLastImportHint = false,
    List<DoctorIssue> assertionIssues = const [],
    String? defaultCurrency = 'CHF',
    String? currencyFilter,
    int refreshTick = 0,
  }) {
    final fromDate = from ?? DateTime(2025, 7);
    final toDate = to ?? DateTime(2026, 6, 30);
    return MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: AccountChartCard(
            // Matches the ValueKey transaction_list_screen.dart gives
            // AccountChartCard in production: a change here must remount a
            // fresh State (not reach didUpdateWidget), same as real usage.
            key: ValueKey((
              spec.id,
              fromDate.toIso8601String(),
              toDate.toIso8601String(),
            )),
            queryRepository: repo,
            spec: spec,
            fromDate: fromDate,
            toDate: toDate,
            onBucketSelected: onBucketSelected,
            onError: onError,
            showsLastImportHint: showsLastImportHint,
            assertionIssues: assertionIssues,
            defaultCurrency: defaultCurrency,
            currencyFilter: currencyFilter,
            refreshTick: refreshTick,
          ),
        ),
      ),
    );
  }

  Widget build(
    AccountResource account, {
    DateTime? from,
    DateTime? to,
    void Function(DateTime, DateTime)? onBucketSelected,
    ValueChanged<ApiError?>? onError,
    bool showsLastImportHint = false,
    List<DoctorIssue> assertionIssues = const [],
    String? defaultCurrency = 'CHF',
    String? currencyFilter,
    int refreshTick = 0,
  }) => buildSpec(
    ChartSpec.forAccount(account),
    from: from,
    to: to,
    onBucketSelected: onBucketSelected,
    onError: onError,
    showsLastImportHint: showsLastImportHint,
    assertionIssues: assertionIssues,
    defaultCurrency: defaultCurrency,
    currencyFilter: currencyFilter,
    refreshTick: refreshTick,
  );

  testWidgets('asset account renders a line with balance and delta', (
    tester,
  ) async {
    when(() => repo.run(any(that: contains('OPEN ON')))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('5800')],
          [2025, 8, _amt('4000')],
        ]),
        error: null,
      ),
    );
    // The independent true-opening-balance query (see bql.dart's
    // openingBalanceQuery — never has OPEN ON) — same value the old
    // first-bucket approximation happened to use here, so the expected
    // percentage below is unchanged.
    when(() => repo.run(any(that: isNot(contains('OPEN ON'))))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, _amt('5800')],
        ], keyCount: 1),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    expect(find.byType(LineChart), findsOneWidget);
    expect(find.text('4,000.00 CHF'), findsOneWidget);
    // Delta chip shows only the percentage change, not the absolute amount.
    expect(find.text('-31.0%'), findsOneWidget);
    expect(find.textContaining('1,800.00'), findsNothing);
    verify(
      () => repo.run(any()),
    ).called(2); // series + the opening-balance fetch

    // Chip is vertically centered against the (much taller) amount text,
    // not bottom-aligned with it.
    final amountCenter = tester.getCenter(find.text('4,000.00 CHF'));
    final chipCenter = tester.getCenter(find.text('-31.0%'));
    expect(chipCenter.dy, closeTo(amountCenter.dy, 2));
  });

  testWidgets('delta chip percentage is independent of bucket granularity '
      '(regression: it used to be derived from the series\' own first '
      "bucket — that bucket's *end* value, which differs by granularity — "
      'instead of the true balance at the range start)', (tester) async {
    when(() => repo.run(any(that: contains('month(date)')))).thenAnswer(
      (_) async => (
        data: _amountResult([
          // First bucket's end (5800) is NOT the true opening balance
          // (5000, mocked below) — under the old bug this alone would
          // have driven the percentage.
          [2025, 7, _amt('5800')],
          [2025, 8, _amt('4000')],
        ]),
        error: null,
      ),
    );
    when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
      (_) async => (
        data: _amountResult([
          // A different first-bucket-end (5750) than the monthly series
          // above — under the old bug, switching granularity alone
          // would have changed the displayed percentage.
          [2025, 7, 1, _amt('5750')],
          [2025, 8, 31, _amt('4000')],
        ], keyCount: 3),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('OPEN ON'))))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, _amt('5000')],
        ], keyCount: 1),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    // (4000 - 5000) / 5000 = -20.0%, using the true opening balance —
    // not -31.0% (vs. the monthly first bucket) or -30.4% (vs. the
    // daily one), either of which the old code would have shown.
    expect(find.text('-20.0%'), findsOneWidget);

    await tester.tap(find.text('Day'));
    await tester.pumpAndSettle();

    // Same true percentage under daily granularity — proves it no
    // longer depends on which bucket size happens to be selected.
    expect(find.text('-20.0%'), findsOneWidget);
  });

  testWidgets('no delta chip when the opening balance is zero', (tester) async {
    when(() => repo.run(any(that: contains('OPEN ON')))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('0')],
          [2025, 8, _amt('500')],
        ]),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('OPEN ON'))))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, _amt('0')],
        ], keyCount: 1),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    // A percentage change from a zero base is undefined — no chip at all,
    // rather than falling back to showing the absolute amount.
    expect(find.textContaining('%'), findsNothing);
  });

  testWidgets(
    'assertion-issue pill is right-justified on the headline row, not the '
    'granularity-chip row',
    (tester) async {
      when(() => repo.run(any())).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('5800')],
            [2025, 8, _amt('4000')],
          ]),
          error: null,
        ),
      );
      const issue = DoctorIssue(
        target: 'balanceAssertions/ba-1',
        code: DoctorIssue.balanceAssertionFailed,
        targetSummary: {'date': '2025-08-15', 'account': 'Assets:Checking:ZKB'},
      );

      await tester.pumpWidget(build(_checking, assertionIssues: [issue]));
      await tester.pumpAndSettle();

      // Same row as the balance amount, pushed to its right — not sharing
      // the chip row below the chart, so the granularity chips stay
      // pinned to that row's right edge regardless of whether there's
      // anything to show here.
      final pillCenter = tester.getCenter(find.text('1'));
      final amountCenter = tester.getCenter(find.text('4,000.00 CHF'));
      final dayChipCenter = tester.getCenter(find.text('Day'));
      expect(pillCenter.dy, closeTo(amountCenter.dy, 2));
      expect(pillCenter.dx, greaterThan(amountCenter.dx));
      expect(pillCenter.dy, lessThan(dayChipCenter.dy));
    },
  );

  testWidgets('headline balance is never truncated with an ellipsis', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 8, _amt('1234567.89')],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    final headline = tester.widget<Text>(find.text('1,234,567.89 CHF'));
    expect(headline.overflow, isNot(TextOverflow.ellipsis));
    expect(headline.maxLines, isNull);
  });

  testWidgets(
    'headline and delta chip do not overflow the header row at narrow widths',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1.0;

      when(() => repo.run(any(that: contains('OPEN ON')))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('5800')],
            [2025, 8, _amt('4000')],
          ]),
          error: null,
        ),
      );
      when(() => repo.run(any(that: isNot(contains('OPEN ON'))))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, _amt('5800')],
          ], keyCount: 1),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.text('4,000.00 CHF'), findsOneWidget);
      expect(find.text('-31.0%'), findsOneWidget);
    },
  );

  testWidgets('liability balances keep their raw negative sign', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2026, 1, _amt('-3200')],
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
        data: _amountResult([
          [2025, 7, _amt('200')],
          [2025, 8, _amt('300')],
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
    'granularity chips are flush right for a flow spec too, matching the '
    'balance chart',
    (tester) async {
      when(() => repo.run(any())).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('200')],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_groceries));
      await tester.pumpAndSettle();

      final yearChipRight = tester.getTopRight(find.text('Year')).dx + 10;
      final cardRight = tester.getTopRight(find.byType(AccountChartCard)).dx;
      expect(yearChipRight, closeTo(cardRight - 12 - 16, 1));
    },
  );

  testWidgets('balance-sheet home view nets Assets and Liabilities into a '
      'net-worth line via one multi-root query', (tester) async {
    when(
      () => repo.run(
        any(
          that: allOf(
            contains("'^(Assets|Liabilities)(:|\$)'"),
            contains('OPEN ON'),
          ),
        ),
      ),
    ).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('1000')],
          [2025, 8, _amt('800')],
        ]),
        error: null,
      ),
    );
    // The independent true-opening-balance query (see bql.dart's
    // openingBalanceQuery — never has OPEN ON); same value the old
    // first-bucket approximation happened to use here, so the expected
    // percentage below is unchanged.
    when(
      () => repo.run(
        any(
          that: allOf(
            contains("'^(Assets|Liabilities)(:|\$)'"),
            isNot(contains('OPEN ON')),
          ),
        ),
      ),
    ).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, _amt('1000')],
        ], keyCount: 1),
        error: null,
      ),
    );

    await tester.pumpWidget(
      buildSpec(ChartSpec.forHomeView(HomeView.balanceSheet)),
    );
    await tester.pumpAndSettle();

    verify(
      () => repo.run(
        any(
          that: allOf(
            contains('last(balance)'),
            contains("'^(Assets|Liabilities)(:|\$)'"),
            contains('OPEN ON'),
          ),
        ),
      ),
    ).called(1);
    expect(find.byType(LineChart), findsOneWidget);
    // Stock semantics: headline is the latest net worth, with a delta chip.
    expect(find.text('800.00 CHF'), findsOneWidget);
    expect(find.text('-20.0%'), findsOneWidget);
  });

  testWidgets('income-statement home view nets Income and Expenses into raw '
      'signed bars via one multi-root query', (tester) async {
    when(
      () => repo.run(any(that: contains("'^(Income|Expenses)(:|\$)'"))),
    ).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('-1000')], // saved: income exceeded expenses
          [2025, 8, _amt('200')], // overspent
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(
      buildSpec(ChartSpec.forHomeView(HomeView.incomeStatement)),
    );
    await tester.pumpAndSettle();

    verify(
      () => repo.run(
        any(
          that: allOf(
            contains('sum(position)'),
            contains("'^(Income|Expenses)(:|\$)'"),
          ),
        ),
      ),
    ).called(1);
    expect(find.byType(BarChart), findsOneWidget);
    // Flow semantics with raw signs: headline is the raw netted total.
    expect(find.text('-800.00 CHF'), findsOneWidget);
    // The negative July bar must be inside the axis range, not clipped.
    final chart = tester.widget<BarChart>(find.byType(BarChart));
    expect(chart.data.minY, lessThanOrEqualTo(-1000));
    expect(chart.data.barGroups.first.barRods.single.toY, -1000);
  });

  testWidgets(
    'shows the converted amount and surfaces price warnings from the fetch',
    (tester) async {
      when(() => repo.run(any())).thenAnswer(
        (_) async => (
          data: QueryResult(
            columns: const [
              QueryColumnDef(name: 'y', type: 'int'),
              QueryColumnDef(name: 'm', type: 'int'),
              QueryColumnDef(name: 'bal', type: 'amount'),
            ],
            rows: [
              [2025, 8, _amt('4040')],
            ],
            warnings: const [
              QueryWarningInfo(
                code: 'missing_price',
                message: 'No CHF price for USD on or before 2025-08-31.',
              ),
            ],
          ),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      expect(find.text('4,040.00 CHF'), findsOneWidget);
      // Series + the independent true-opening-balance fetch for the delta
      // chip (see bql.dart's openingBalanceQuery) — this test doesn't care
      // about the chip's content, just that a fetch happened.
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
    'changing the default currency re-fetches with the new target and never '
    'mislabels stale values',
    (tester) async {
      when(() => repo.run(any(that: contains("'CHF'")))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 8, _amt('4040')],
          ]),
          error: null,
        ),
      );
      when(() => repo.run(any(that: contains("'USD'")))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 8, _amt('4750', 'USD')],
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
    'headline keeps showing the previous value (correctly still labeled in '
    'its own currency) while a new conversion is pending '
    '(regression: headline blanked to nothing during that gap)',
    (tester) async {
      when(() => repo.run(any(that: contains("'CHF'")))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 8, _amt('4040')],
          ]),
          error: null,
        ),
      );
      final usdCompleter = Completer<({QueryResult? data, ApiError? error})>();
      when(
        () => repo.run(any(that: contains("'USD'"))),
      ).thenAnswer((_) => usdCompleter.future);

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();
      expect(find.text('4,040.00 CHF'), findsOneWidget);

      await tester.pumpWidget(build(_checking, defaultCurrency: 'USD'));
      await tester.pump(); // USD fetch requested but still pending

      // Still showing the previous (CHF) value under its own correct
      // label — not blank, and not mislabeled as USD.
      expect(find.text('4,040.00 CHF'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.byType(LineChart), findsNothing);

      usdCompleter.complete((
        data: _amountResult([
          [2025, 8, _amt('4750', 'USD')],
        ]),
        error: null,
      ));
      await tester.pumpAndSettle();
      expect(find.text('4,750.00 USD'), findsOneWidget);
    },
  );

  testWidgets('currencyFilter scopes the query to that commodity', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100', 'USD')],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking, currencyFilter: 'USD'));
    await tester.pumpAndSettle();

    // Both the series and the independent opening-balance query (see
    // bql.dart's openingBalanceQuery) are scoped by currencyFilter.
    verify(() => repo.run(any(that: contains("currency = 'USD'")))).called(2);
  });

  testWidgets('changing the currencyFilter re-queries the chart', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100', 'USD')],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking, currencyFilter: 'USD'));
    await tester.pumpAndSettle();
    // Series + the independent opening-balance query (see bql.dart's
    // openingBalanceQuery).
    verify(() => repo.run(any())).called(2);

    await tester.pumpWidget(build(_checking, currencyFilter: 'EUR'));
    await tester.pumpAndSettle();

    verify(() => repo.run(any(that: contains("currency = 'EUR'")))).called(2);
  });

  testWidgets('a first-load failure reports onError and renders nothing — no '
      'in-card error UI, since the parent owns the shared banner/retry', (
    tester,
  ) async {
    when(
      () => repo.run(any()),
    ).thenAnswer((_) async => (data: null, error: const AuthError()));
    ApiError? reported;
    var reportCount = 0;

    await tester.pumpWidget(
      build(
        _checking,
        onError: (e) {
          reported = e;
          reportCount++;
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(reported, const AuthError());
    expect(reportCount, 1);
    expect(find.text('Retry'), findsNothing);
    expect(find.byType(AccountChartCard), findsOneWidget);
    // Nothing rendered in the card's place — no message, no spinner.
    expect(find.byType(Container), findsNothing);

    // A retry is the parent bumping refreshTick, exactly like any other
    // same-view reload (granularity/currency/refresh) — the card has no
    // retry affordance of its own.
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
        ]),
        error: null,
      ),
    );
    await tester.pumpWidget(
      build(
        _checking,
        refreshTick: 1,
        onError: (e) {
          reported = e;
          reportCount++;
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('100.00 CHF'), findsOneWidget);
    expect(reported, isNull);
    expect(reportCount, 2);
  });

  testWidgets(
    'a same-view reload failure keeps the previous content visible instead '
    'of collapsing the whole card, and reports onError instead of showing '
    'its own error UI '
    '(regression: header/headline disappeared behind a bare error box)',
    (tester) async {
      when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
        (_) async => (data: null, error: const NetworkError('timed out')),
      );
      when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
          ]),
          error: null,
        ),
      );
      ApiError? reported;

      await tester.pumpWidget(build(_checking, onError: (e) => reported = e));
      await tester.pumpAndSettle();
      expect(find.text('100.00 CHF'), findsOneWidget);
      expect(reported, isNull);

      // Same-view reload (granularity tap) fails.
      await tester.tap(find.text('Day'));
      await tester.pumpAndSettle();

      // Stale headline/granularity chips survive — no error box or retry
      // button anywhere in the card; onError carries the failure instead.
      expect(find.text('100.00 CHF'), findsOneWidget);
      expect(find.text('Day'), findsOneWidget);
      expect(find.text('timed out'), findsNothing);
      expect(find.text('Retry'), findsNothing);
      expect(reported, const NetworkError('timed out'));

      // Retrying (a refreshTick bump, same as any other parent-driven
      // reload) recovers the chart.
      when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, 15, _amt('150')],
          ], keyCount: 3),
          error: null,
        ),
      );
      await tester.pumpWidget(
        build(_checking, refreshTick: 1, onError: (e) => reported = e),
      );
      await tester.pumpAndSettle();

      expect(find.text('150.00 CHF'), findsOneWidget);
      expect(find.byType(LineChart), findsOneWidget);
      expect(reported, isNull);
    },
  );

  testWidgets('empty series shows a hint instead of a chart', (tester) async {
    when(
      () => repo.run(any()),
    ).thenAnswer((_) async => (data: _amountResult([]), error: null));

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    expect(find.text('No data in range'), findsOneWidget);
    expect(find.byType(LineChart), findsNothing);
  });

  testWidgets('no default currency configured warns instead of guessing one', (
    tester,
  ) async {
    await tester.pumpWidget(build(_checking, defaultCurrency: null));
    await tester.pumpAndSettle();

    expect(
      find.text('Set a default currency in App Settings to see this chart.'),
      findsOneWidget,
    );
    expect(find.byType(LineChart), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    // No default currency to convert to — nothing is ever fetched.
    verifyNever(() => repo.run(any()));
  });

  testWidgets(
    'gaining a default currency after mounting without one loads the chart',
    (tester) async {
      when(() => repo.run(any())).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking, defaultCurrency: null));
      await tester.pumpAndSettle();
      expect(
        find.text('Set a default currency in App Settings to see this chart.'),
        findsOneWidget,
      );

      // e.g. the user just picked one in App Settings while this screen
      // was still mounted underneath.
      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      expect(find.text('100.00 CHF'), findsOneWidget);
    },
  );

  testWidgets(
    'losing the default currency while mounted falls back to the warning',
    (tester) async {
      when(() => repo.run(any())).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();
      expect(find.text('100.00 CHF'), findsOneWidget);

      // e.g. the user cleared the setting in App Settings.
      await tester.pumpWidget(build(_checking, defaultCurrency: null));
      await tester.pumpAndSettle();

      expect(
        find.text('Set a default currency in App Settings to see this chart.'),
        findsOneWidget,
      );
      expect(find.text('100.00 CHF'), findsNothing);
    },
  );

  testWidgets('last-import hint appears when the filter toggle is on', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
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
        data: _amountResult([
          [2025, 7, _amt('5800')],
          [2025, 8, _amt('4000')],
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
    'first load shows a spinner (not a crash) while the fetch is pending',
    (tester) async {
      final completer = Completer<({QueryResult? data, ApiError? error})>();
      when(() => repo.run(any())).thenAnswer((_) => completer.future);

      await tester.pumpWidget(build(_checking));
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.byType(LineChart), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      completer.complete((
        data: _amountResult([
          [2025, 8, _amt('4040')],
        ]),
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
        data: _amountResult([
          for (var m = 1; m <= 12; m++) [2025, m, _amt('${100 + m}')],
        ]),
        error: null,
      ),
    );
    // Uses the expense (bar-chart) account, which never renders a delta
    // chip, to isolate axis-label thinning from the header row layout.
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
        data: _amountResult([
          [2025, 7, _amt('100')],
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
        data: _amountResult([
          [2025, 7, 15, _amt('150')],
        ], keyCount: 3),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
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

  testWidgets(
    'switching granularity keeps the header/headline visible instead of '
    'collapsing the card to the loading placeholder '
    '(regression: card got visibly shorter while a same-view reload ran)',
    (tester) async {
      final dailyCompleter =
          Completer<({QueryResult? data, ApiError? error})>();
      when(
        () => repo.run(any(that: contains('day(date)'))),
      ).thenAnswer((_) => dailyCompleter.future);
      when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();
      expect(find.text('100.00 CHF'), findsOneWidget);

      await tester.tap(find.text('Day'));
      await tester.pump(); // reload starts; daily query still pending

      // Stale header/headline stay up (same view, just a different
      // granularity) rather than the card collapsing to the small
      // full-card spinner used only when there's no previous data at all.
      expect(find.text('100.00 CHF'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.byType(LineChart), findsNothing);

      dailyCompleter.complete((
        data: _amountResult([
          [2025, 7, 15, _amt('150')],
        ], keyCount: 3),
        error: null,
      ));
      await tester.pumpAndSettle();
      expect(find.text('150.00 CHF'), findsOneWidget);
    },
  );

  testWidgets('tapping Year re-queries with only a year bucket', (
    tester,
  ) async {
    when(() => repo.run(any(that: contains('month(date)')))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
        ]),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('month(date)'))))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, _amt('999')],
        ], keyCount: 1),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Year'));
    await tester.pumpAndSettle();

    // isNot('month(date)') also matches the independent opening-balance
    // query (see bql.dart's openingBalanceQuery, always year-only) from
    // both the initial load and the year tap, plus the year tap's own
    // series call: 3 total, none yet consumed by an earlier verify.
    verify(() => repo.run(any(that: isNot(contains('month(date)'))))).called(3);
    expect(find.text('999.00 CHF'), findsOneWidget);
  });

  testWidgets(
    'granularity choice resets to the span-derived default when the date '
    'range changes',
    (tester) async {
      when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, 15, _amt('150')],
          ], keyCount: 3),
          error: null,
        ),
      );
      when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
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
      // fetched fresh for the new range, not a second daily query. (The
      // prior daily call was already consumed by the `verify` above, so any
      // further match here would have to be a new one.)
      await tester.pumpWidget(
        build(_checking, from: DateTime(2024), to: DateTime(2024, 12, 31)),
      );
      await tester.pumpAndSettle();

      verifyNever(() => repo.run(any(that: contains('day(date)'))));
      // Genuinely re-fetched for the new range (not just silently keeping
      // the old range's data around) — each of the 3 loads so far (initial,
      // the daily tap, this new view) issues a monthly/yearly series call
      // plus an independent opening-balance call (see bql.dart's
      // openingBalanceQuery, never day-bucketed); the daily tap's own
      // series call is the only one excluded (it has day(date), already
      // consumed by the verify above) — 5 of the 6 total calls remain.
      verify(() => repo.run(any(that: isNot(contains('day(date)'))))).called(5);
    },
  );

  testWidgets(
    'granularity choice survives a refreshTick-only change (e.g. editing an '
    'unrelated transaction)',
    (tester) async {
      when(() => repo.run(any(that: contains('day(date)')))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, 15, _amt('150')],
          ], keyCount: 3),
          error: null,
        ),
      );
      when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
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
        data: _amountResult([
          [2025, 7, 15, _amt('150')],
        ], keyCount: 3),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
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

  testWidgets('valuation chip row offers Cost and Market for a balance spec', (
    tester,
  ) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    expect(find.text('Cost'), findsOneWidget);
    expect(find.text('Market'), findsOneWidget);
  });

  testWidgets(
    'valuation chips stay left and granularity chips stay flush right on '
    'the same row',
    (tester) async {
      when(() => repo.run(any())).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
          ]),
          error: null,
        ),
      );

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      final costCenter = tester.getCenter(find.text('Cost'));
      final yearCenter = tester.getCenter(find.text('Year'));
      expect(costCenter.dy, closeTo(yearCenter.dy, 1));
      expect(costCenter.dx, lessThan(yearCenter.dx));

      // The chip's own tap-target edge, not the label text's — see
      // _chip's 10px horizontal padding.
      final yearChipRight = tester.getTopRight(find.text('Year')).dx + 10;
      final cardRight = tester.getTopRight(find.byType(AccountChartCard)).dx;
      // Card margin (12) + padding (16) separate the card's outer bound
      // from its content area.
      expect(yearChipRight, closeTo(cardRight - 12 - 16, 1));
    },
  );

  testWidgets('valuation chip row is absent for a flow spec', (tester) async {
    when(() => repo.run(any())).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
        ]),
        error: null,
      ),
    );

    await tester.pumpWidget(build(_groceries));
    await tester.pumpAndSettle();

    expect(find.text('Cost'), findsNothing);
    expect(find.text('Market'), findsNothing);
  });

  testWidgets('tapping Market re-queries with convert(value(...))', (
    tester,
  ) async {
    when(() => repo.run(any(that: _seriesValueQuery))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('150')],
        ]),
        error: null,
      ),
    );
    when(() => repo.run(any(that: _seriesCostQuery))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
        ]),
        error: null,
      ),
    );
    when(
      () => repo.run(any(that: contains('FROM CLOSE ON'))),
    ).thenAnswer((_) async => (data: _amountResult([]), error: null));

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();
    verifyNever(() => repo.run(any(that: _seriesValueQuery)));

    await tester.tap(find.text('Market'));
    await tester.pumpAndSettle();

    verify(() => repo.run(any(that: _seriesValueQuery))).called(1);
    expect(find.text('150.00 CHF'), findsOneWidget);
  });

  testWidgets('valuation choice resets to Cost when the date range changes', (
    tester,
  ) async {
    when(() => repo.run(any(that: _seriesValueQuery))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('150')],
        ]),
        error: null,
      ),
    );
    when(() => repo.run(any(that: _seriesCostQuery))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
        ]),
        error: null,
      ),
    );
    when(
      () => repo.run(any(that: contains('FROM CLOSE ON'))),
    ).thenAnswer((_) async => (data: _amountResult([]), error: null));

    await tester.pumpWidget(build(_checking));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Market'));
    await tester.pumpAndSettle();
    verify(() => repo.run(any(that: _seriesValueQuery))).called(1);

    // A new date range is a new view: the Market override doesn't
    // survive it — back to Cost, and the new view's fetches must not
    // include another value() query.
    await tester.pumpWidget(
      build(_checking, from: DateTime(2024), to: DateTime(2024, 12, 31)),
    );
    await tester.pumpAndSettle();

    verifyNever(() => repo.run(any(that: _seriesValueQuery)));
  });

  testWidgets(
    'valuation choice survives a refreshTick-only change (e.g. editing an '
    'unrelated transaction)',
    (tester) async {
      when(() => repo.run(any(that: _seriesValueQuery))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('150')],
          ]),
          error: null,
        ),
      );
      when(() => repo.run(any(that: _seriesCostQuery))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
          ]),
          error: null,
        ),
      );
      when(
        () => repo.run(any(that: contains('FROM CLOSE ON'))),
      ).thenAnswer((_) async => (data: _amountResult([]), error: null));

      await tester.pumpWidget(build(_checking));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Market'));
      await tester.pumpAndSettle();
      verify(() => repo.run(any(that: _seriesValueQuery))).called(1);

      await tester.pumpWidget(build(_checking, refreshTick: 1));
      await tester.pumpAndSettle();

      verify(() => repo.run(any(that: _seriesValueQuery))).called(1);
    },
  );

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
        data: _amountResult([
          for (var i = 0; i < 100; i++)
            _dailyRow(start.add(Duration(days: i)), '10'),
        ], keyCount: 3),
        error: null,
      ),
    );
    when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
      (_) async => (
        data: _amountResult([
          [2025, 7, _amt('100')],
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
          data: _amountResult([
            for (var i = 0; i < bucketCount; i++)
              _dailyRow(start.add(Duration(days: i)), '10'),
          ], keyCount: 3),
          error: null,
        ),
      );
      when(() => repo.run(any(that: isNot(contains('day(date)'))))).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2025, 7, _amt('100')],
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
          data: _amountResult([
            [2025, 7, _amt('100')],
          ]),
          error: null,
        ),
      );
      when(
        () => repo.run(any(that: isNot(contains('month(date)')))),
      ).thenAnswer(
        (_) async => (
          data: _amountResult([
            [2023, _amt('100')],
            [2024, _amt('150')],
          ], keyCount: 1),
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
        data: _amountResult([
          [2025, 7, _amt('1000')],
          [2025, 10, _amt('1000')],
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
