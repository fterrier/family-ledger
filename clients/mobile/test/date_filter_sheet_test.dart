import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';
import 'package:family_ledger_mobile/screens/transactions/date_filter_sheet.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter.dart';

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
}
