import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/account_category.dart';

void main() {
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
