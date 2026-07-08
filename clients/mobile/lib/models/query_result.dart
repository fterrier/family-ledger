/// Typed client model for POST /ledger:query responses.
///
/// Cells are decoded per the column's declared type (see the cell-encoding
/// table in docs/specs/reporting-query.md): int -> int, str -> String?,
/// date -> DateTime, decimal -> String, amount -> QueryAmount?,
/// inventory -> List&lt;QueryAmount&gt;. Unknown column types pass the raw
/// JSON value through (forward compatibility is the client's duty).
library;

class QueryAmount {
  final String number;
  final String currency;

  const QueryAmount({required this.number, required this.currency});

  factory QueryAmount.fromJson(Map<String, dynamic> json) => QueryAmount(
    number: json['number'] as String,
    currency: json['currency'] as String,
  );

  @override
  bool operator ==(Object other) =>
      other is QueryAmount &&
      other.number == number &&
      other.currency == currency;

  @override
  int get hashCode => Object.hash(number, currency);

  @override
  String toString() => '$number $currency';
}

class QueryColumnDef {
  final String name;
  final String type;

  const QueryColumnDef({required this.name, required this.type});

  factory QueryColumnDef.fromJson(Map<String, dynamic> json) => QueryColumnDef(
    name: json['name'] as String,
    type: json['type'] as String,
  );
}

class QueryWarningInfo {
  final String code;
  final String message;
  final Map<String, String> details;

  const QueryWarningInfo({
    required this.code,
    required this.message,
    this.details = const {},
  });

  factory QueryWarningInfo.fromJson(Map<String, dynamic> json) =>
      QueryWarningInfo(
        code: json['code'] as String,
        message: json['message'] as String,
        details: (json['details'] as Map<String, dynamic>? ?? {}).map(
          (key, value) => MapEntry(key, value as String),
        ),
      );
}

class QueryResult {
  final List<QueryColumnDef> columns;
  final List<List<Object?>> rows;
  final List<QueryWarningInfo> warnings;

  const QueryResult({
    required this.columns,
    required this.rows,
    required this.warnings,
  });

  factory QueryResult.fromJson(Map<String, dynamic> json) {
    final columns = (json['columns'] as List<dynamic>)
        .map((c) => QueryColumnDef.fromJson(c as Map<String, dynamic>))
        .toList();
    final rows = (json['rows'] as List<dynamic>).map((row) {
      final cells = row as List<dynamic>;
      return [
        for (var i = 0; i < cells.length; i++)
          _decodeCell(cells[i], columns[i].type),
      ];
    }).toList();
    final warnings = (json['warnings'] as List<dynamic>? ?? [])
        .map((w) => QueryWarningInfo.fromJson(w as Map<String, dynamic>))
        .toList();
    return QueryResult(columns: columns, rows: rows, warnings: warnings);
  }

  static Object? _decodeCell(Object? cell, String type) {
    if (cell == null) return null;
    switch (type) {
      case 'int':
        return (cell as num).toInt();
      case 'str':
      case 'decimal':
        return cell as String;
      case 'date':
        return DateTime.parse(cell as String);
      case 'amount':
        return QueryAmount.fromJson(cell as Map<String, dynamic>);
      case 'inventory':
        return (cell as List<dynamic>)
            .map((e) => QueryAmount.fromJson(e as Map<String, dynamic>))
            .toList();
      default:
        return cell;
    }
  }
}
