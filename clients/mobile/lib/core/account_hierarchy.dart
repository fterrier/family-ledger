import '../models/account.dart';

/// Builds the account-picker superset: real accounts plus synthesized
/// prefix entries for every intermediate `:`-separated path segment that is
/// not itself a real account. Selecting a prefix filters/charts the whole
/// subtree.
List<AccountResource> buildPickerAccounts(List<AccountResource> accounts) {
  final realAccountNames = accounts.map((a) => a.accountName).toSet();
  final prefixPaths = <String>{};
  for (final a in accounts) {
    final parts = a.accountName.split(':');
    var prefix = parts[0];
    for (var i = 1; i < parts.length; i++) {
      if (!realAccountNames.contains(prefix)) {
        prefixPaths.add(prefix);
      }
      prefix = '$prefix:${parts[i]}';
    }
  }
  return [...prefixPaths.map(AccountResource.prefix), ...accounts]
    ..sort((a, b) => a.accountName.compareTo(b.accountName));
}
