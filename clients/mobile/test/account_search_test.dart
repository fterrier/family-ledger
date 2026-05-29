import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/account_search.dart';
import 'package:family_ledger_mobile/models/account.dart';

AccountResource _acct(String name) => AccountResource(
  name: 'accounts/${name.toLowerCase().replaceAll(' ', '_')}',
  accountName: name,
  effectiveStartDate: '2020-01-01',
);

void main() {
  group('isOrderedCharacterMatch', () {
    test('empty query matches everything', () {
      expect(isOrderedCharacterMatch('', 'Expenses:Food:Restaurant'), isTrue);
    });

    test('exact match', () {
      expect(
        isOrderedCharacterMatch('expenses', 'Expenses:Food:Restaurant'),
        isTrue,
      );
    });

    test('ordered characters match non-contiguously', () {
      expect(
        isOrderedCharacterMatch('efr', 'Expenses:Food:Restaurant'),
        isTrue,
      );
      expect(isOrderedCharacterMatch('aw', 'Assets:Cash:Wallet'), isTrue);
    });

    test('case-insensitive', () {
      expect(
        isOrderedCharacterMatch('EFR', 'Expenses:Food:Restaurant'),
        isTrue,
      );
      expect(
        isOrderedCharacterMatch('efr', 'EXPENSES:FOOD:RESTAURANT'),
        isTrue,
      );
    });

    test('out-of-order characters do not match', () {
      expect(
        isOrderedCharacterMatch('rfe', 'Expenses:Food:Restaurant'),
        isFalse,
      );
    });

    test('character not in candidate does not match', () {
      expect(
        isOrderedCharacterMatch('xyz', 'Expenses:Food:Restaurant'),
        isFalse,
      );
    });

    test('query longer than candidate does not match', () {
      expect(isOrderedCharacterMatch('abcdefghij', 'abc'), isFalse);
    });

    test('leading and trailing whitespace in query is ignored', () {
      expect(
        isOrderedCharacterMatch('  efr  ', 'Expenses:Food:Restaurant'),
        isTrue,
      );
    });

    test('whitespace-only query matches everything', () {
      expect(
        isOrderedCharacterMatch('   ', 'Expenses:Food:Restaurant'),
        isTrue,
      );
    });
  });

  group('filterAccounts', () {
    final accounts = [
      _acct('Assets:Cash:Wallet'),
      _acct('Expenses:Food:Restaurant'),
      _acct('Expenses:Food:Groceries'),
      _acct('Expenses:Transport:Train'),
      _acct('Income:Salary'),
    ];

    test('empty query returns all accounts', () {
      expect(filterAccounts(accounts, ''), accounts);
    });

    test('filters by ordered match', () {
      final result = filterAccounts(accounts, 'efr');
      expect(
        result.map((a) => a.accountName),
        contains('Expenses:Food:Restaurant'),
      );
      expect(
        result.map((a) => a.accountName),
        isNot(contains('Assets:Cash:Wallet')),
      );
    });

    test('matches multiple accounts with same prefix', () {
      final result = filterAccounts(accounts, 'ef');
      expect(result.length, 2);
      final names = result.map((a) => a.accountName).toList();
      expect(names, contains('Expenses:Food:Restaurant'));
      expect(names, contains('Expenses:Food:Groceries'));
    });

    test('case-insensitive filtering', () {
      final result = filterAccounts(accounts, 'EF');
      expect(result, isNotEmpty);
    });

    test('no match returns empty list', () {
      final result = filterAccounts(accounts, 'zzz');
      expect(result, isEmpty);
    });
  });
}
