import '../models/account.dart';

bool isOrderedCharacterMatch(String query, String candidate) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  return _matchNormalized(q, candidate);
}

bool _matchNormalized(String normalizedQuery, String candidate) {
  final c = candidate.toLowerCase();
  int qi = 0;
  for (int ci = 0; ci < c.length; ci++) {
    if (c[ci] == normalizedQuery[qi]) {
      qi++;
      if (qi == normalizedQuery.length) return true;
    }
  }
  return false;
}

List<AccountResource> filterAccounts(
  List<AccountResource> accounts,
  String query,
) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return accounts;
  return accounts.where((a) => _matchNormalized(q, a.accountName)).toList();
}
