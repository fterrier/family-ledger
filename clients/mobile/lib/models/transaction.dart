import 'posting.dart';

class PostingResource {
  final String account;
  final String? accountName;
  final MoneyValue units;
  final String? narration;
  final MoneyValue? cost;
  final MoneyValue? price;

  /// Units valued in the list request's `convert` currency at the
  /// transaction date; null when not requested, already that currency, or
  /// no price path exists (compare symbols to tell the last two apart).
  final MoneyValue? convertedUnits;

  const PostingResource({
    required this.account,
    this.accountName,
    required this.units,
    this.narration,
    this.cost,
    this.price,
    this.convertedUnits,
  });

  factory PostingResource.fromJson(Map<String, dynamic> json) =>
      PostingResource(
        account: json['account'] as String,
        accountName: json['account_name'] as String?,
        units: MoneyValue.fromJson(json['units'] as Map<String, dynamic>),
        narration: json['narration'] as String?,
        cost: json['cost'] == null
            ? null
            : MoneyValue.fromJson(json['cost'] as Map<String, dynamic>),
        price: json['price'] == null
            ? null
            : MoneyValue.fromJson(json['price'] as Map<String, dynamic>),
        convertedUnits: json['converted_units'] == null
            ? null
            : MoneyValue.fromJson(
                json['converted_units'] as Map<String, dynamic>,
              ),
      );
}

class TransactionResource {
  final String name;
  final String transactionDate;
  final String? payee;
  final String? narration;
  final List<PostingResource> postings;

  const TransactionResource({
    required this.name,
    required this.transactionDate,
    this.payee,
    this.narration,
    required this.postings,
  });

  factory TransactionResource.fromJson(Map<String, dynamic> json) =>
      TransactionResource(
        name: json['name'] as String,
        transactionDate: json['transaction_date'] as String,
        payee: json['payee'] as String?,
        narration: json['narration'] as String?,
        postings: (json['postings'] as List)
            .map((e) => PostingResource.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

Map<String, dynamic> _transactionJson({
  required String transactionDate,
  required String? payee,
  required String? narration,
  required List<PostingPayload> postings,
}) => {
  'transaction_date': transactionDate,
  if (payee != null && payee.isNotEmpty) 'payee': payee,
  if (narration != null && narration.isNotEmpty) 'narration': narration,
  'postings': postings.map((p) => p.toJson()).toList(),
};

class TransactionCreate {
  final String transactionDate;
  final String? payee;
  final String? narration;
  final List<PostingPayload> postings;

  const TransactionCreate({
    required this.transactionDate,
    this.payee,
    this.narration,
    required this.postings,
  });

  Map<String, dynamic> toJson() => {
    'transaction': _transactionJson(
      transactionDate: transactionDate,
      payee: payee,
      narration: narration,
      postings: postings,
    ),
  };
}

class TransactionUpdate {
  final String transactionDate;
  final String? payee;
  final String? narration;
  final List<PostingPayload> postings;

  const TransactionUpdate({
    required this.transactionDate,
    this.payee,
    this.narration,
    required this.postings,
  });

  Map<String, dynamic> toJson() => {
    'transaction': _transactionJson(
      transactionDate: transactionDate,
      payee: payee,
      narration: narration,
      postings: postings,
    ),
  };
}
