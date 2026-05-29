import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/posting.dart';
import 'package:family_ledger_mobile/models/transaction.dart';

void main() {
  group('AccountResource', () {
    test('fromJson parses correctly', () {
      final account = AccountResource.fromJson({
        'name': 'accounts/acc_123',
        'account_name': 'Expenses:Food:Restaurant',
        'effective_start_date': '2020-01-01',
        'effective_end_date': null,
      });
      expect(account.name, 'accounts/acc_123');
      expect(account.accountName, 'Expenses:Food:Restaurant');
      expect(account.isActive, true);
    });

    test('isActive false when effectiveEndDate set', () {
      final account = AccountResource.fromJson({
        'name': 'accounts/acc_456',
        'account_name': 'Expenses:Food:Takeout',
        'effective_start_date': '2020-01-01',
        'effective_end_date': '2024-12-31',
      });
      expect(account.isActive, false);
    });

    test('displayName replaces colons with middot', () {
      final account = AccountResource.fromJson({
        'name': 'accounts/acc_789',
        'account_name': 'Expenses:Food:Restaurant',
        'effective_start_date': '2020-01-01',
        'effective_end_date': null,
      });
      expect(account.displayName, 'Expenses · Food · Restaurant');
    });
  });

  group('TransactionCreate.toJson', () {
    test('serializes two-posting cash transaction correctly', () {
      const tx = TransactionCreate(
        transactionDate: '2026-05-28',
        payee: 'Migros',
        postings: [
          PostingPayload(
            account: 'accounts/acc_from',
            units: MoneyValue(amount: '-42.50', symbol: 'CHF'),
          ),
          PostingPayload(
            account: 'accounts/acc_to',
            units: MoneyValue(amount: '42.50', symbol: 'CHF'),
          ),
        ],
      );
      final json = tx.toJson();
      final inner = json['transaction'] as Map<String, dynamic>;

      expect(inner['transaction_date'], '2026-05-28');
      expect(inner['payee'], 'Migros');
      final postings = inner['postings'] as List;
      expect(postings.length, 2);
      expect((postings[0] as Map)['units']['amount'], '-42.50');
      expect((postings[1] as Map)['units']['amount'], '42.50');
      // Amounts are strings, never doubles.
      expect((postings[0] as Map)['units']['amount'], isA<String>());
    });

    test('omits null payee from JSON', () {
      const tx = TransactionCreate(
        transactionDate: '2026-05-28',
        postings: [
          PostingPayload(
            account: 'accounts/acc_from',
            units: MoneyValue(amount: '-10.00', symbol: 'CHF'),
          ),
          PostingPayload(
            account: 'accounts/acc_to',
            units: MoneyValue(amount: '10.00', symbol: 'CHF'),
          ),
        ],
      );
      final inner = tx.toJson()['transaction'] as Map<String, dynamic>;
      expect(inner.containsKey('payee'), false);
    });
  });
}
