import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter.dart';

const _account = AccountResource(
  name: 'accounts/acc_checking',
  accountName: 'Assets:Bank:Checking',
  effectiveStartDate: '2020-01-01',
);

void main() {
  group('TransactionFilter.toQueryParams', () {
    test('empty filter returns empty map', () {
      expect(const TransactionFilter().toQueryParams(), isEmpty);
    });

    test('account-only filter sends account_name, no date keys', () {
      final params = const TransactionFilter(account: _account).toQueryParams();
      expect(params['account_name'], 'Assets:Bank:Checking');
      expect(params.containsKey('account'), isFalse);
      expect(params.containsKey('from_date'), isFalse);
      expect(params.containsKey('to_date'), isFalse);
    });

    test('prefix account also sends account_name param', () {
      final prefix = AccountResource.prefix('Assets:Bank');
      final params = TransactionFilter(account: prefix).toQueryParams();
      expect(params['account_name'], 'Assets:Bank');
      expect(params.containsKey('account'), isFalse);
    });

    test('fromDate only — has from_date, no to_date', () {
      final params = TransactionFilter(
        fromDate: DateTime(2025, 6),
      ).toQueryParams();
      expect(params['from_date'], '2025-06-01');
      expect(params.containsKey('to_date'), isFalse);
    });

    test('toDate only — has to_date, no from_date', () {
      final params = TransactionFilter(
        toDate: DateTime(2025, 6, 30),
      ).toQueryParams();
      expect(params['to_date'], '2025-06-30');
      expect(params.containsKey('from_date'), isFalse);
    });

    test('both dates present — both keys with yyyy-MM-dd format', () {
      final params = TransactionFilter(
        fromDate: DateTime(2025),
        toDate: DateTime(2025, 12, 31),
      ).toQueryParams();
      expect(params['from_date'], '2025-01-01');
      expect(params['to_date'], '2025-12-31');
    });

    test('full year selection — Jan 1 / Dec 31', () {
      final params = TransactionFilter(
        fromDate: DateTime(2025),
        toDate: DateTime(2025, 12, 31),
      ).toQueryParams();
      expect(params['from_date'], '2025-01-01');
      expect(params['to_date'], '2025-12-31');
    });

    test('month range — Jun 1 / Jun 30', () {
      final params = TransactionFilter(
        fromDate: DateTime(2025, 6),
        toDate: DateTime(2025, 6, 30),
      ).toQueryParams();
      expect(params['from_date'], '2025-06-01');
      expect(params['to_date'], '2025-06-30');
    });

    test('account + dates combined', () {
      final params = TransactionFilter(
        account: _account,
        fromDate: DateTime(2024),
        toDate: DateTime(2024, 12, 31),
      ).toQueryParams();
      expect(params['account_name'], 'Assets:Bank:Checking');
      expect(params.containsKey('account'), isFalse);
      expect(params['from_date'], '2024-01-01');
      expect(params['to_date'], '2024-12-31');
    });

    test('lastImportOnly: true sends last_import=true', () {
      final params = const TransactionFilter(
        lastImportOnly: true,
      ).toQueryParams();
      expect(params['last_import'], 'true');
    });

    test('lastImportOnly: false (default) omits last_import param', () {
      expect(
        const TransactionFilter().toQueryParams().containsKey('last_import'),
        isFalse,
      );
    });

    test('currency filter sends currency param', () {
      final params = const TransactionFilter(currency: 'USD').toQueryParams();
      expect(params['currency'], 'USD');
    });

    test('no currency filter omits currency param', () {
      expect(
        const TransactionFilter().toQueryParams().containsKey('currency'),
        isFalse,
      );
    });
  });

  group('TransactionFilter.dateRangeLabel', () {
    test('both null → null', () {
      expect(const TransactionFilter().dateRangeLabel, isNull);
    });

    test('full single year → year string', () {
      final f = TransactionFilter(
        fromDate: DateTime(2025),
        toDate: DateTime(2025, 12, 31),
      );
      expect(f.dateRangeLabel, '2025');
    });

    test('full year range → year–year string', () {
      final f = TransactionFilter(
        fromDate: DateTime(2024),
        toDate: DateTime(2025, 12, 31),
      );
      expect(f.dateRangeLabel, '2024–2025');
    });

    test('same-year months (Jun–Aug 2025)', () {
      final f = TransactionFilter(
        fromDate: DateTime(2025, 6),
        toDate: DateTime(2025, 8, 31),
      );
      expect(f.dateRangeLabel, 'Jun–Aug 2025');
    });

    test('single month (Jun 2025)', () {
      final f = TransactionFilter(
        fromDate: DateTime(2025, 6),
        toDate: DateTime(2025, 6, 30),
      );
      expect(f.dateRangeLabel, 'Jun 2025');
    });

    test('cross-year months', () {
      final f = TransactionFilter(
        fromDate: DateTime(2024, 6),
        toDate: DateTime(2025, 3, 31),
      );
      expect(f.dateRangeLabel, 'Jun 2024 – Mar 2025');
    });

    test('from-only open-ended', () {
      final f = TransactionFilter(fromDate: DateTime(2025, 6));
      expect(f.dateRangeLabel, 'From Jun 2025');
    });

    test('to-only open-ended', () {
      final f = TransactionFilter(toDate: DateTime(2025, 12, 31));
      expect(f.dateRangeLabel, 'To Dec 2025');
    });

    test('December last-day edge case — Dec 31 detected as year end', () {
      final f = TransactionFilter(
        fromDate: DateTime(2025),
        toDate: DateTime(2025, 12, 31),
      );
      expect(f.dateRangeLabel, '2025');
    });
  });

  group('TransactionFilter.isActive', () {
    test('default filter is not active', () {
      expect(const TransactionFilter().isActive, isFalse);
    });

    test('active when account set', () {
      expect(const TransactionFilter(account: _account).isActive, isTrue);
    });

    test('active when fromDate set', () {
      expect(TransactionFilter(fromDate: DateTime(2025)).isActive, isTrue);
    });

    test('active when toDate set', () {
      expect(
        TransactionFilter(toDate: DateTime(2025, 12, 31)).isActive,
        isTrue,
      );
    });

    test('active when lastImportOnly set', () {
      expect(const TransactionFilter(lastImportOnly: true).isActive, isTrue);
    });

    test('active when currency set', () {
      expect(const TransactionFilter(currency: 'USD').isActive, isTrue);
    });
  });

  group('TransactionFilter.copyWith', () {
    test('preserves unchanged fields', () {
      final f = TransactionFilter(
        account: _account,
        fromDate: DateTime(2025),
        toDate: DateTime(2025, 12, 31),
      );
      final copy = f.copyWith();
      expect(copy.account, f.account);
      expect(copy.fromDate, f.fromDate);
      expect(copy.toDate, f.toDate);
    });

    test('can clear account to null using sentinel', () {
      const f = TransactionFilter(account: _account);
      final copy = f.copyWith(account: null);
      expect(copy.account, isNull);
    });

    test('can clear fromDate to null using sentinel', () {
      final f = TransactionFilter(fromDate: DateTime(2025));
      final copy = f.copyWith(fromDate: null);
      expect(copy.fromDate, isNull);
    });

    test('can clear toDate to null using sentinel', () {
      final f = TransactionFilter(toDate: DateTime(2025, 12, 31));
      final copy = f.copyWith(toDate: null);
      expect(copy.toDate, isNull);
    });

    test('can update individual fields', () {
      final f = TransactionFilter(
        fromDate: DateTime(2025),
        toDate: DateTime(2025, 12, 31),
      );
      final copy = f.copyWith(fromDate: DateTime(2024));
      expect(copy.fromDate, DateTime(2024));
      expect(copy.toDate, f.toDate);
    });

    test('can set currency', () {
      const f = TransactionFilter();
      final copy = f.copyWith(currency: 'USD');
      expect(copy.currency, 'USD');
    });

    test('can clear currency to null using sentinel', () {
      const f = TransactionFilter(currency: 'USD');
      final copy = f.copyWith(currency: null);
      expect(copy.currency, isNull);
    });

    test('preserves currency when unchanged', () {
      const f = TransactionFilter(currency: 'USD');
      final copy = f.copyWith(fromDate: DateTime(2025));
      expect(copy.currency, 'USD');
    });
  });
}
