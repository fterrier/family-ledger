import 'package:intl/intl.dart';
import '../../core/home_view.dart';
import '../../models/account.dart';

class TransactionFilter {
  final AccountResource? account;
  final DateTime? fromDate;
  final DateTime? toDate;
  final String? currency;
  final bool lastImportOnly;

  /// Which pseudo-view the home screen shows while [account] is null. It is
  /// retained when an account is selected, so clearing the account returns
  /// to the last home view.
  final HomeView homeView;

  const TransactionFilter({
    this.account,
    this.fromDate,
    this.toDate,
    this.currency,
    this.lastImportOnly = false,
    this.homeView = HomeView.balanceSheet,
  });

  bool get isActive =>
      account != null ||
      fromDate != null ||
      toDate != null ||
      hasMoreFilters ||
      homeView != HomeView.balanceSheet;

  /// Backs the "more filters" action icon's badge dot.
  bool get hasMoreFilters => currency != null || lastImportOnly;

  static const Object _absent = Object();

  TransactionFilter copyWith({
    Object? account = _absent,
    Object? fromDate = _absent,
    Object? toDate = _absent,
    Object? currency = _absent,
    bool? lastImportOnly,
    HomeView? homeView,
  }) {
    return TransactionFilter(
      account: identical(account, _absent)
          ? this.account
          : account as AccountResource?,
      fromDate: identical(fromDate, _absent)
          ? this.fromDate
          : fromDate as DateTime?,
      toDate: identical(toDate, _absent) ? this.toDate : toDate as DateTime?,
      currency: identical(currency, _absent)
          ? this.currency
          : currency as String?,
      lastImportOnly: lastImportOnly ?? this.lastImportOnly,
      homeView: homeView ?? this.homeView,
    );
  }

  Map<String, String> toQueryParams() {
    final params = <String, String>{};
    if (account != null) {
      params['account_name'] = account!.accountName;
    }
    if (fromDate != null) params['from_date'] = _fmt.format(fromDate!);
    if (toDate != null) params['to_date'] = _fmt.format(toDate!);
    if (currency != null) params['currency'] = currency!;
    if (lastImportOnly) params['last_import'] = 'true';
    return params;
  }

  String? get accountLabel => account?.displayName;

  String? get dateRangeLabel {
    final from = fromDate;
    final to = toDate;
    if (from == null && to == null) return null;

    if (from != null && to != null) {
      final fromIsYearStart = from.month == 1 && from.day == 1;
      final toIsYearEnd = to.month == 12 && to.day == 31;

      if (fromIsYearStart && toIsYearEnd) {
        if (from.year == to.year) return '${from.year}';
        return '${from.year}–${to.year}';
      }

      final fromIsMonthStart = from.day == 1;
      final toIsMonthEnd = to.day == _lastDayOfMonth(to.year, to.month);

      if (fromIsMonthStart && toIsMonthEnd && from.year == to.year) {
        if (from.month == to.month) return _monthFmt.format(from);
        return '${_shortMonthFmt.format(from)}–${_monthFmt.format(to)}';
      }

      return '${_monthFmt.format(from)} – ${_monthFmt.format(to)}';
    }

    if (from != null) return 'From ${_monthFmt.format(from)}';
    return 'To ${_monthFmt.format(to!)}';
  }

  static final _fmt = DateFormat('yyyy-MM-dd');
  static final _monthFmt = DateFormat('MMM yyyy');
  static final _shortMonthFmt = DateFormat('MMM');
}

int _lastDayOfMonth(int year, int month) => DateTime(year, month + 1, 0).day;
