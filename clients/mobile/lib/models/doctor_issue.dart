class DoctorIssue {
  static const balanceAssertionFailed = 'balance_assertion_failed';
  static const transactionUnbalanced = 'transaction_unbalanced';

  final String? target;
  final String code;
  final String message;
  final Map<String, String> details;
  final Map<String, String> targetSummary;

  const DoctorIssue({
    this.target,
    required this.code,
    this.message = '',
    this.details = const {},
    this.targetSummary = const {},
  });

  factory DoctorIssue.fromJson(Map<String, dynamic> json) => DoctorIssue(
    target: json['target'] as String?,
    code: json['code'] as String,
    message: json['message'] as String? ?? '',
    details: _stringMap(json['details']),
    targetSummary: _stringMap(json['target_summary']),
  );

  static Map<String, String> _stringMap(Object? value) =>
      (value as Map<String, dynamic>? ?? {}).map(
        (key, v) => MapEntry(key, v as String),
      );

  /// Account name a balance-assertion failure applies to, if any.
  String? get accountName => targetSummary['account'];

  DateTime? get date => DateTime.tryParse(targetSummary['date'] ?? '');
}
