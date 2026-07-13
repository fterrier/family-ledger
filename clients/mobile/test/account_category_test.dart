import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/account_category.dart';
import 'package:family_ledger_mobile/core/home_view.dart';

void main() {
  group('HomeView', () {
    test('balance sheet nets Assets and Liabilities as a line', () {
      expect(HomeView.balanceSheet.label, 'Balance sheet');
      expect(HomeView.balanceSheet.rootAccounts, ['Assets', 'Liabilities']);
      expect(HomeView.balanceSheet.isFlow, isFalse);
    });

    test('income statement nets Income and Expenses as bars', () {
      expect(HomeView.incomeStatement.label, 'Income statement');
      expect(HomeView.incomeStatement.rootAccounts, ['Income', 'Expenses']);
      expect(HomeView.incomeStatement.isFlow, isTrue);
    });

    test('view themes are distinct from every account category theme', () {
      for (final view in HomeView.values) {
        final theme = themeForHomeView(view);
        for (final categoryTheme in accountCategoryThemes.values) {
          expect(theme.color, isNot(categoryTheme.color));
        }
      }
    });
  });

  group('categoryOf', () {
    test('matches exact top-level account names', () {
      expect(categoryOf('Expenses'), AccountCategory.expense);
      expect(categoryOf('Income'), AccountCategory.income);
      expect(categoryOf('Assets'), AccountCategory.asset);
      expect(categoryOf('Liabilities'), AccountCategory.liability);
    });

    test('matches deep account paths', () {
      expect(categoryOf('Expenses:Food:Groceries'), AccountCategory.expense);
      expect(categoryOf('Income:Salary'), AccountCategory.income);
      expect(categoryOf('Assets:Checking:ZKB'), AccountCategory.asset);
      expect(categoryOf('Liabilities:CreditCard'), AccountCategory.liability);
    });

    test('falls back to equity for unknown roots and null', () {
      expect(categoryOf('Equity:OpeningBalances'), AccountCategory.equity);
      expect(categoryOf(null), AccountCategory.equity);
    });
  });
}
