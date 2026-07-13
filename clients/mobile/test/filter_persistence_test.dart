import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:family_ledger_mobile/core/filter_persistence.dart';
import 'package:family_ledger_mobile/core/home_view.dart';
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

  test('round-trips a non-default home view with no other filters', () async {
    // Regression guard: isActive must count the view, or save() clears
    // every key and the view resets on the next launch.
    await FilterPersistence.save(
      const TransactionFilter(homeView: HomeView.incomeStatement),
    );

    final loaded = await FilterPersistence.load();

    expect(loaded.homeView, HomeView.incomeStatement);
  });

  test('resetting to the default view removes the persisted key', () async {
    await FilterPersistence.save(
      const TransactionFilter(homeView: HomeView.incomeStatement),
    );
    await FilterPersistence.save(const TransactionFilter());

    final loaded = await FilterPersistence.load();

    expect(loaded.homeView, HomeView.balanceSheet);
  });

  test('missing home view key (old prefs) defaults to balance sheet', () async {
    final loaded = await FilterPersistence.load();

    expect(loaded.homeView, HomeView.balanceSheet);
  });
}
