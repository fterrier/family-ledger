class Commodity {
  final String name;   // "commodities/chf"
  final String symbol; // "CHF"

  const Commodity({required this.name, required this.symbol});

  factory Commodity.fromJson(Map<String, dynamic> json) => Commodity(
    name: json['name'] as String,
    symbol: json['symbol'] as String,
  );
}
