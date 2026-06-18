import 'posting.dart';

class PostingResource {
  final String account;
  final MoneyValue units;

  const PostingResource({required this.account, required this.units});

  factory PostingResource.fromJson(Map<String, dynamic> json) {
    final units = json['units'] as Map<String, dynamic>;
    return PostingResource(
      account: json['account'] as String,
      units: MoneyValue(
        amount: units['amount'] as String,
        symbol: units['symbol'] as String,
      ),
    );
  }
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
    'transaction': {
      'transaction_date': transactionDate,
      if (payee != null && payee!.isNotEmpty) 'payee': payee,
      if (narration != null && narration!.isNotEmpty) 'narration': narration,
      'postings': postings.map((p) => p.toJson()).toList(),
    },
  };
}
