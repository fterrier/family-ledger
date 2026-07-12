import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/repositories/commodity_repository.dart';
import 'package:family_ledger_mobile/screens/transactions/more_filters_sheet.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter.dart';

class MockCommodityRepository extends Mock implements CommodityRepository {}

const _checking = AccountResource(
  name: 'accounts/acc-1',
  accountName: 'Assets:Checking:ZKB',
  effectiveStartDate: '2020-01-01',
);

void main() {
  late MockCommodityRepository commodityRepo;

  setUp(() {
    commodityRepo = MockCommodityRepository();
    when(() => commodityRepo.getAllCommodities()).thenAnswer(
      (_) async => (
        data: const [
          Commodity(name: 'commodities/chf', symbol: 'CHF'),
          Commodity(name: 'commodities/usd', symbol: 'USD'),
        ],
        error: null,
      ),
    );
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
                  result.value = await showMoreFiltersSheet(
                    context,
                    current: current,
                    commodityRepository: commodityRepo,
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

  testWidgets('shows Any commodity plus a chip per loaded commodity', (
    tester,
  ) async {
    await pumpSheet(tester, current: const TransactionFilter());

    expect(find.text('Commodity'), findsOneWidget);
    expect(find.text('Any commodity'), findsOneWidget);
    expect(find.text('CHF'), findsOneWidget);
    expect(find.text('USD'), findsOneWidget);
  });

  testWidgets('picking a commodity and applying returns it on the filter', (
    tester,
  ) async {
    final result = await pumpSheet(tester, current: const TransactionFilter());

    await tester.tap(find.text('USD'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(result.value?.currency, 'USD');
  });

  testWidgets('tapping Any clears an existing commodity filter', (
    tester,
  ) async {
    final result = await pumpSheet(
      tester,
      current: const TransactionFilter(currency: 'USD'),
    );

    await tester.tap(find.text('Any commodity'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(result.value?.currency, isNull);
  });

  testWidgets('toggling last import and applying returns it set', (
    tester,
  ) async {
    final result = await pumpSheet(tester, current: const TransactionFilter());

    await tester.tap(find.text('Last import'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(result.value?.lastImportOnly, isTrue);
  });

  testWidgets(
    'Reset clears currency and last-import but preserves account and dates',
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

      expect(result.value?.currency, isNull);
      expect(result.value?.lastImportOnly, isFalse);
      expect(result.value?.account, _checking);
      expect(result.value?.fromDate, DateTime(2025));
      expect(result.value?.toDate, DateTime(2025, 12, 31));
    },
  );
}
