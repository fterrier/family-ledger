import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:family_ledger_mobile/core/filter_persistence.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('round-trips a currency-only filter', () async {
    await FilterPersistence.save(const TransactionFilter(currency: 'USD'));

    final loaded = await FilterPersistence.load();

    expect(loaded.currency, 'USD');
  });

  test('clearing the filter removes the persisted currency', () async {
    await FilterPersistence.save(const TransactionFilter(currency: 'USD'));
    await FilterPersistence.save(const TransactionFilter());

    final loaded = await FilterPersistence.load();

    expect(loaded.currency, isNull);
  });

  test('loading with nothing persisted has no currency', () async {
    final loaded = await FilterPersistence.load();

    expect(loaded.currency, isNull);
  });
}
