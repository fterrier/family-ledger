import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/posting_sum.dart';
import 'package:family_ledger_mobile/models/posting.dart';
import 'package:family_ledger_mobile/models/transaction.dart';

PostingResource _posting(
  String? accountName,
  String amount,
  String symbol, {
  MoneyValue? converted,
}) => PostingResource(
  account: 'accounts/acc-x',
  accountName: accountName,
  units: MoneyValue(amount: amount, symbol: symbol),
  convertedUnits: converted,
);

void main() {
  group('sumPostings subtree matching', () {
    test('sums exact and descendant accounts under a root', () {
      final sums = sumPostings(
        [
          _posting('Assets', '10', 'CHF'),
          _posting('Assets:Checking:ZKB', '5', 'CHF'),
          _posting('Expenses:Food', '3', 'CHF'),
        ],
        ['Assets'],
        target: 'CHF',
      );
      expect(sums.converted, 15);
    });

    test('root boundary: AssetsX never matches the Assets subtree', () {
      final sums = sumPostings(
        [_posting('AssetsX:Other', '999', 'CHF')],
        ['Assets'],
        target: 'CHF',
      );
      expect(sums.isEmpty, isTrue);
    });

    test('multiple roots net together with raw signs', () {
      final sums = sumPostings(
        [
          _posting('Assets:Checking', '1000', 'CHF'),
          _posting('Liabilities:Card', '-200', 'CHF'),
          _posting('Equity:Opening', '-800', 'CHF'),
        ],
        ['Assets', 'Liabilities'],
        target: 'CHF',
      );
      expect(sums.converted, 800);
    });

    test('null accountName never matches', () {
      final sums = sumPostings(
        [_posting(null, '10', 'CHF')],
        ['Assets'],
        target: 'CHF',
      );
      expect(sums.isEmpty, isTrue);
    });
  });

  group('sumPostings conversion buckets', () {
    test('foreign postings use converted_units and keep their original', () {
      final sums = sumPostings(
        [
          _posting('Assets:Checking', '-100', 'CHF'),
          _posting(
            'Assets:Broker',
            '40',
            'USD',
            converted: const MoneyValue(amount: '34', symbol: 'CHF'),
          ),
        ],
        ['Assets'],
        target: 'CHF',
      );
      expect(sums.converted, -66);
      expect(sums.originals, {'USD': 40});
      expect(sums.unconverted, isEmpty);
    });

    test('no price path keeps the raw per-currency sum separate', () {
      final sums = sumPostings(
        [_posting('Assets:Wallet', '500', 'JPY')],
        ['Assets'],
        target: 'CHF',
      );
      expect(sums.converted, isNull);
      expect(sums.unconverted, {'JPY': 500});
    });

    test('without a target everything stays per-currency raw', () {
      final sums = sumPostings(
        [
          _posting('Assets:Checking', '-100', 'CHF'),
          _posting('Assets:Broker', '40', 'USD'),
        ],
        ['Assets'],
      );
      expect(sums.converted, isNull);
      expect(sums.unconverted, {'CHF': -100, 'USD': 40});
    });

    test('unparsable amounts are skipped', () {
      final sums = sumPostings(
        [
          _posting('Assets:Checking', 'garbage', 'CHF'),
          _posting('Assets:Checking', '5', 'CHF'),
        ],
        ['Assets'],
        target: 'CHF',
      );
      expect(sums.converted, 5);
    });
  });
}
