import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/posting_sum.dart';
import 'package:family_ledger_mobile/models/posting.dart';
import 'package:family_ledger_mobile/models/transaction.dart';

PostingResource _posting(
  String? accountName,
  String amount,
  String symbol, {
  MoneyValue? converted,
  MoneyValue? weight,
}) => PostingResource(
  account: 'accounts/acc-x',
  accountName: accountName,
  units: MoneyValue(amount: amount, symbol: symbol),
  weight: weight ?? MoneyValue(amount: amount, symbol: symbol),
  convertedWeights: converted,
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
    test('a multi-currency mix shows every currency behind the total, '
        "including the target's own — not just the foreign one", () {
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
      expect(sums.originals, {'CHF': -100, 'USD': 40});
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

    test('a security posting with cost shows its weight (cost value), not the '
        'raw share count, even with no conversion target configured', () {
      final sums = sumPostings(
        [
          _posting(
            'Assets:Broker:VSS',
            '100',
            'VSS',
            weight: const MoneyValue(amount: '11779.00', symbol: 'USD'),
          ),
        ],
        ['Assets'],
      );
      expect(sums.converted, isNull);
      // Not {'VSS': 100} — the client never displays raw share counts.
      expect(sums.unconverted, {'USD': 11779.00});
    });

    test('a posting already in the target currency still uses convertedWeights '
        'when the server populates it (e.g. bought at cost in another '
        'currency, so raw units understate its current value)', () {
      final sums = sumPostings(
        [
          _posting(
            'Assets:Broker',
            '200',
            'CHF',
            converted: const MoneyValue(amount: '600', symbol: 'CHF'),
          ),
        ],
        ['Assets'],
        target: 'CHF',
      );
      // Not 200 (raw units) — the server already re-priced via the
      // posting's weight, and that must win over the raw pass-through.
      expect(sums.converted, 600);
      // Same symbol as target, so no secondary "original" line — the
      // primary number already speaks for itself.
      expect(sums.originals, isEmpty);
    });

    test('a currency that nets to exactly 0 across the matched postings is '
        "left out of the secondary line, even though it's part of the mix", () {
      final sums = sumPostings(
        [
          _posting('Assets:Checking', '-100', 'CHF'),
          _posting(
            'Assets:Broker',
            '40',
            'USD',
            converted: const MoneyValue(amount: '34', symbol: 'CHF'),
          ),
          _posting(
            'Assets:Broker',
            '-40',
            'USD',
            converted: const MoneyValue(amount: '-34', symbol: 'CHF'),
          ),
        ],
        ['Assets'],
        target: 'CHF',
      );
      expect(sums.converted, -100);
      // USD nets to 0 (40 + -40) and is dropped; only CHF is left, which
      // alone needs no secondary line either.
      expect(sums.originals, isEmpty);
    });

    test('multiple postings in the same non-target currency are netted into '
        'one secondary-line entry, not shown per-posting', () {
      final sums = sumPostings(
        [
          _posting('Assets:Checking', '-100', 'CHF'),
          _posting(
            'Assets:Broker',
            '40',
            'USD',
            converted: const MoneyValue(amount: '34', symbol: 'CHF'),
          ),
          _posting(
            'Assets:Broker',
            '10',
            'USD',
            converted: const MoneyValue(amount: '8.5', symbol: 'CHF'),
          ),
        ],
        ['Assets'],
        target: 'CHF',
      );
      expect(sums.converted, -57.5);
      expect(sums.originals, {'CHF': -100, 'USD': 50});
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
