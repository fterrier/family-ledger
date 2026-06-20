class MoneyValue {
  // amount is a string per API contract — never serialize as double.
  final String amount;
  final String symbol;

  const MoneyValue({required this.amount, required this.symbol});

  factory MoneyValue.fromJson(Map<String, dynamic> json) => MoneyValue(
    amount: json['amount'] as String,
    symbol: json['symbol'] as String,
  );

  Map<String, dynamic> toJson() => {'amount': amount, 'symbol': symbol};
}

class PostingPayload {
  final String account;
  final MoneyValue units;
  final String? narration;
  final MoneyValue? cost;
  final MoneyValue? price;

  const PostingPayload({
    required this.account,
    required this.units,
    this.narration,
    this.cost,
    this.price,
  });

  Map<String, dynamic> toJson() => {
    'account': account,
    'units': units.toJson(),
    if (narration != null && narration!.isNotEmpty) 'narration': narration,
    if (cost != null) 'cost': cost!.toJson(),
    if (price != null) 'price': price!.toJson(),
  };
}
