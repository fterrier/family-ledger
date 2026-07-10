import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/repositories/commodity_repository.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter_sheet.dart';

class MockTransactionRepository extends Mock implements TransactionRepository {}

class MockCommodityRepository extends Mock implements CommodityRepository {}

void main() {
  late MockTransactionRepository txRepo;
  late MockCommodityRepository commodityRepo;

  setUp(() {
    txRepo = MockTransactionRepository();
    commodityRepo = MockCommodityRepository();
    when(
      () => txRepo.getYearRange(),
    ).thenAnswer((_) async => (data: (2024, 2026), error: null));
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

  testWidgets('shows Any commodity plus a chip per loaded commodity', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showTransactionFilterSheet(
                  context,
                  accounts: const [],
                  current: const TransactionFilter(),
                  transactionRepository: txRepo,
                  commodityRepository: commodityRepo,
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    expect(find.text('Commodity'), findsOneWidget);
    expect(find.text('Any commodity'), findsOneWidget);
    expect(find.text('CHF'), findsOneWidget);
    expect(find.text('USD'), findsOneWidget);
  });

  testWidgets('picking a commodity and applying returns it on the filter', (
    tester,
  ) async {
    late TransactionFilter? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  result = await showTransactionFilterSheet(
                    context,
                    accounts: const [],
                    current: const TransactionFilter(),
                    transactionRepository: txRepo,
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

    await tester.tap(find.text('USD'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(result?.currency, 'USD');
  });

  testWidgets('tapping Any clears an existing commodity filter', (
    tester,
  ) async {
    late TransactionFilter? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  result = await showTransactionFilterSheet(
                    context,
                    accounts: const [],
                    current: const TransactionFilter(currency: 'USD'),
                    transactionRepository: txRepo,
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

    await tester.tap(find.text('Any commodity'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(result?.currency, isNull);
  });
}
