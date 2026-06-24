import 'package:shared_preferences/shared_preferences.dart';
import '../models/account.dart';
import '../screens/transactions/transaction_filter.dart';

class FilterPersistence {
  static const _keyAccountName = 'tx_filter_account_name';
  static const _keyAccountDisplayName = 'tx_filter_account_display_name';
  static const _keyAccountIsPrefix = 'tx_filter_account_is_prefix';
  static const _keyFromDate = 'tx_filter_from_date';
  static const _keyToDate = 'tx_filter_to_date';

  static Future<TransactionFilter> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final accountName = prefs.getString(_keyAccountName);
      final accountDisplayName = prefs.getString(_keyAccountDisplayName);
      final fromStr = prefs.getString(_keyFromDate);
      final toStr = prefs.getString(_keyToDate);

      AccountResource? account;
      if (accountName != null && accountDisplayName != null) {
        final isPrefix = prefs.getBool(_keyAccountIsPrefix) ?? false;
        account = isPrefix
            ? AccountResource.prefix(accountName)
            : AccountResource(
                name: accountName,
                accountName: accountDisplayName,
                effectiveStartDate: '',
              );
      }

      return TransactionFilter(
        account: account,
        fromDate: fromStr != null ? DateTime.tryParse(fromStr) : null,
        toDate: toStr != null ? DateTime.tryParse(toStr) : null,
      );
    } catch (_) {
      return const TransactionFilter();
    }
  }

  static Future<void> save(TransactionFilter filter) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!filter.isActive) {
        await Future.wait([
          prefs.remove(_keyAccountName),
          prefs.remove(_keyAccountDisplayName),
          prefs.remove(_keyFromDate),
          prefs.remove(_keyToDate),
        ]);
        return;
      }
      final futures = <Future<void>>[];
      if (filter.account != null) {
        futures.add(prefs.setString(_keyAccountName, filter.account!.name));
        futures.add(
          prefs.setString(_keyAccountDisplayName, filter.account!.accountName),
        );
        futures.add(
          prefs.setBool(_keyAccountIsPrefix, filter.account!.isPrefix),
        );
      } else {
        futures.add(prefs.remove(_keyAccountName));
        futures.add(prefs.remove(_keyAccountDisplayName));
        futures.add(prefs.remove(_keyAccountIsPrefix));
      }
      if (filter.fromDate != null) {
        futures.add(
          prefs.setString(
            _keyFromDate,
            filter.fromDate!.toIso8601String().substring(0, 10),
          ),
        );
      } else {
        futures.add(prefs.remove(_keyFromDate));
      }
      if (filter.toDate != null) {
        futures.add(
          prefs.setString(
            _keyToDate,
            filter.toDate!.toIso8601String().substring(0, 10),
          ),
        );
      } else {
        futures.add(prefs.remove(_keyToDate));
      }
      await Future.wait(futures);
    } catch (_) {
      // Persistence failures are non-critical — silently ignore.
    }
  }
}
