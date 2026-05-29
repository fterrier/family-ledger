class AccountResource {
  final String name;
  final String accountName;
  final String effectiveStartDate;
  final String? effectiveEndDate;

  const AccountResource({
    required this.name,
    required this.accountName,
    required this.effectiveStartDate,
    this.effectiveEndDate,
  });

  bool get isActive => effectiveEndDate == null;

  factory AccountResource.fromJson(Map<String, dynamic> json) {
    return AccountResource(
      name: json['name'] as String,
      accountName: json['account_name'] as String,
      effectiveStartDate: json['effective_start_date'] as String,
      effectiveEndDate: json['effective_end_date'] as String?,
    );
  }

  String get displayName =>
      accountName.replaceAll(' - ', ' · ').replaceAll(':', ' · ');
}
