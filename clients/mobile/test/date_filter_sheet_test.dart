import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/core/error_reporter.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';
import 'package:family_ledger_mobile/screens/transactions/date_filter_sheet.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter.dart';
import 'package:family_ledger_mobile/widgets/error_banner.dart';
import 'package:family_ledger_mobile/widgets/filter_pill.dart';

class MockTransactionRepository extends Mock implements TransactionRepository {}

const _checking = AccountResource(
  name: 'accounts/acc-1',
  accountName: 'Assets:Checking:ZKB',
  effectiveStartDate: '2020-01-01',
);

void main() {
  late MockTransactionRepository txRepo;

  setUp(() {
    txRepo = MockTransactionRepository();
    when(
      () => txRepo.getYearRange(),
    ).thenAnswer((_) async => (data: (2024, 2026), error: null));
  });

  // Mounts a placeholder "Open" screen whose button opens the sheet with
  // `current`, storing the eventual Apply/Reset result in `result.value` —
  // the test then interacts with the sheet before reading it.
  Future<ValueNotifier<TransactionFilter?>> pumpSheet(
    WidgetTester tester, {
    required TransactionFilter current,
  }) async {
    final result = ValueNotifier<TransactionFilter?>(null);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  result.value = await showDateFilterSheet(
                    context,
                    current: current,
                    transactionRepository: txRepo,
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
    return result;
  }

  testWidgets('shows a pill per year in range', (tester) async {
    await pumpSheet(tester, current: const TransactionFilter());

    expect(find.text('2024'), findsOneWidget);
    expect(find.text('2025'), findsOneWidget);
    expect(find.text('2026'), findsOneWidget);
  });

  testWidgets('tapping a year sets the full year as from/to and applying '
      'returns it', (tester) async {
    final result = await pumpSheet(tester, current: const TransactionFilter());

    await tester.tap(find.text('2025'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(result.value?.fromDate, DateTime(2025));
    expect(result.value?.toDate, DateTime(2025, 12, 31));
  });

  testWidgets('tapping the same single-year pill again clears the range', (
    tester,
  ) async {
    final result = await pumpSheet(
      tester,
      current: TransactionFilter(
        fromDate: DateTime(2025),
        toDate: DateTime(2025, 12, 31),
      ),
    );

    await tester.tap(find.text('2025'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(result.value?.fromDate, isNull);
    expect(result.value?.toDate, isNull);
  });

  testWidgets(
    'Reset clears the date range but preserves account and currency',
    (tester) async {
      final current = TransactionFilter(
        account: _checking,
        fromDate: DateTime(2025),
        toDate: DateTime(2025, 12, 31),
        currency: 'USD',
        lastImportOnly: true,
      );
      final result = await pumpSheet(tester, current: current);

      await tester.tap(find.text('Reset'));
      await tester.pumpAndSettle();

      expect(result.value?.fromDate, isNull);
      expect(result.value?.toDate, isNull);
      expect(result.value?.account, _checking);
      expect(result.value?.currency, 'USD');
      expect(result.value?.lastImportOnly, isTrue);
    },
  );

  testWidgets(
    'shows an error banner instead of silently rendering no year pills '
    '(regression: a failed fetch was indistinguishable from "no years")',
    (tester) async {
      when(() => txRepo.getYearRange()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('down')),
      );

      await pumpSheet(tester, current: const TransactionFilter());

      expect(find.byType(ErrorBanner), findsOneWidget);
      expect(find.byType(FilterPill), findsNothing);
    },
  );

  testWidgets(
    'a slow, superseded getYearRange response must not overwrite a later, '
    'faster one (regression: no generation guard on _loadYears meant a '
    'double-tapped Retry could let a stale response clobber a newer one)',
    (tester) async {
      final responses = <Completer<({(int, int)? data, ApiError? error})>>[];
      when(() => txRepo.getYearRange()).thenAnswer((_) {
        final completer = Completer<({(int, int)? data, ApiError? error})>();
        responses.add(completer);
        return completer.future;
      });

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DateFilterSheet(
              initial: const TransactionFilter(),
              transactionRepository: txRepo,
              errors: ErrorReporter(),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(responses.length, 1);

      // First response fails — the banner's Retry starts a second call.
      responses[0].complete((data: null, error: const NetworkError('down')));
      await tester.pumpAndSettle();
      expect(find.byType(ErrorBanner), findsOneWidget);

      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(responses.length, 2);

      // A second, even later Retry tap before the first one resolved.
      await tester.tap(find.text('Retry'), warnIfMissed: false);
      await tester.pump();
      expect(responses.length, 3);

      // The later call wins.
      responses[2].complete((data: (2024, 2026), error: null));
      await tester.pump();
      expect(find.text('2026'), findsOneWidget);

      // The earlier, now-superseded call resolves after it — must be
      // discarded, not applied.
      responses[1].complete((data: null, error: const NetworkError('down')));
      await tester.pump();
      expect(find.text('2026'), findsOneWidget);
      expect(find.byType(ErrorBanner), findsNothing);
    },
  );
}
