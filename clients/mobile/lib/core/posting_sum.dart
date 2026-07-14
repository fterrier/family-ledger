import '../models/transaction.dart';
import 'account_hierarchy.dart';

/// Sums of a transaction's postings under a set of account subtree roots —
/// raw ledger signs throughout, no transforms.
class PostingSums {
  /// Sum in the conversion target currency: postings already in that
  /// currency plus the server-converted value of foreign ones. Null when no
  /// matched posting contributed (no target, or all foreign without a
  /// price path).
  final double? converted;

  /// Original per-currency sums of the foreign postings folded into
  /// [converted] — shown as the secondary line under the amount.
  final Map<String, double> originals;

  /// Per-currency raw sums of matched postings that could not be converted
  /// (no target requested, or no price path on the server).
  final Map<String, double> unconverted;

  const PostingSums({
    required this.converted,
    required this.originals,
    required this.unconverted,
  });

  bool get isEmpty => converted == null && unconverted.isEmpty;
}

/// Sums the postings whose account is one of [roots] or a descendant
/// (`X` or `X:*`, matching the server's subtree semantics). Null account
/// names never match; unparsable amounts are skipped.
PostingSums sumPostings(
  List<PostingResource> postings,
  List<String> roots, {
  String? target,
}) {
  double? converted;
  final originals = <String, double>{};
  final unconverted = <String, double>{};
  for (final posting in postings) {
    final accountName = posting.accountName;
    if (accountName == null) continue;
    if (!roots.any((root) => isAccountOrDescendant(accountName, root))) {
      continue;
    }
    final raw = double.tryParse(posting.units.amount);
    if (raw == null) continue;
    if (target != null && posting.units.symbol == target) {
      converted = (converted ?? 0) + raw;
    } else if (target != null && posting.convertedUnits != null) {
      final convertedAmount = double.tryParse(posting.convertedUnits!.amount);
      if (convertedAmount == null) continue;
      converted = (converted ?? 0) + convertedAmount;
      originals[posting.units.symbol] =
          (originals[posting.units.symbol] ?? 0) + raw;
    } else {
      unconverted[posting.units.symbol] =
          (unconverted[posting.units.symbol] ?? 0) + raw;
    }
  }
  return PostingSums(
    converted: converted,
    originals: originals,
    unconverted: unconverted,
  );
}
