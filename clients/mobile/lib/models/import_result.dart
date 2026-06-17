class EntityCounts {
  final int created;
  final int duplicate;
  final int errorCount;
  final List<String> errorExamples;

  const EntityCounts({
    required this.created,
    required this.duplicate,
    required this.errorCount,
    required this.errorExamples,
  });

  factory EntityCounts.fromJson(Map<String, dynamic> json) {
    final errors = json['errors'] as Map<String, dynamic>?;
    return EntityCounts(
      created: json['created'] as int? ?? 0,
      duplicate: json['duplicate'] as int? ?? 0,
      errorCount: errors?['count'] as int? ?? 0,
      errorExamples:
          (errors?['examples'] as List<dynamic>?)?.cast<String>() ?? [],
    );
  }
}

class ImportResult {
  final Map<String, EntityCounts> entities;
  final List<String> warnings;

  const ImportResult({required this.entities, required this.warnings});

  factory ImportResult.fromJson(Map<String, dynamic> json) => ImportResult(
    entities: (json['entities'] as Map<String, dynamic>? ?? {}).map(
      (key, value) =>
          MapEntry(key, EntityCounts.fromJson(value as Map<String, dynamic>)),
    ),
    warnings: (json['warnings'] as List<dynamic>?)?.cast<String>() ?? [],
  );

  bool get hasErrors => entities.values.any((e) => e.errorCount > 0);
}
