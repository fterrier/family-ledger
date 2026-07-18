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
    // The weight (cost/price-adjusted, or raw units when there's neither —
    // server-computed, never re-derived here) is always the value shown,
    // converted or not: a security holds its cost value, not a raw share
    // count, and a plain currency posting's weight is just its units.
    final weight = posting.weight;
    final weightAmount = double.tryParse(weight.amount);
    if (weightAmount == null) continue;
    // convertedWeights is always the conversion basis, checked first — a
    // posting can have units already in the target currency yet still need
    // converting (e.g. 100 CHF bought at cost {1.2 USD} is really 120 USD
    // spent, converting to more or less than a trivial 100 CHF today).
    if (target != null && posting.convertedWeights != null) {
      final convertedAmount = double.tryParse(posting.convertedWeights!.amount);
      if (convertedAmount == null) continue;
      converted = (converted ?? 0) + convertedAmount;
      if (weight.symbol != target) {
        originals[weight.symbol] =
            (originals[weight.symbol] ?? 0) + weightAmount;
      }
    } else if (target != null && weight.symbol == target) {
      // No convertedWeights (server omits it only when convert wasn't
      // requested, or no price path exists for the weight's currency) but
      // the weight already matches target — the raw value is still usable.
      converted = (converted ?? 0) + weightAmount;
    } else {
      unconverted[weight.symbol] =
          (unconverted[weight.symbol] ?? 0) + weightAmount;
    }
  }
  return PostingSums(
    converted: converted,
    originals: originals,
    unconverted: unconverted,
  );
}
