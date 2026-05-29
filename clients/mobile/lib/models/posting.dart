class MoneyValue {
  // amount is a string per API contract — never serialize as double.
  final String amount;
  final String symbol;

  const MoneyValue({required this.amount, required this.symbol});

  Map<String, dynamic> toJson() => {'amount': amount, 'symbol': symbol};
}

class PostingPayload {
  final String account;
  final MoneyValue units;

  const PostingPayload({required this.account, required this.units});

  Map<String, dynamic> toJson() => {
    'account': account,
    'units': units.toJson(),
  };
}
