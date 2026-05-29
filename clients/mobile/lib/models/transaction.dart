import 'posting.dart';

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
