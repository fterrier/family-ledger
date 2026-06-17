class FileDescriptor {
  final String name;
  final String label;
  final List<String> accept;
  final bool required;

  const FileDescriptor({
    required this.name,
    required this.label,
    required this.accept,
    required this.required,
  });

  factory FileDescriptor.fromJson(Map<String, dynamic> json) => FileDescriptor(
    name: json['name'] as String,
    label: json['label'] as String,
    accept: (json['accept'] as List<dynamic>?)?.cast<String>() ?? [],
    required: json['required'] as bool? ?? false,
  );
}

class Importer {
  final String name;
  final String pluginName;
  final String displayName;
  final List<FileDescriptor> fileDescriptors;

  const Importer({
    required this.name,
    required this.pluginName,
    required this.displayName,
    required this.fileDescriptors,
  });

  factory Importer.fromJson(Map<String, dynamic> json) => Importer(
    name: json['name'] as String,
    pluginName: json['plugin_name'] as String,
    displayName: json['display_name'] as String,
    fileDescriptors:
        (json['file_descriptors'] as List<dynamic>?)
            ?.map((e) => FileDescriptor.fromJson(e as Map<String, dynamic>))
            .toList() ??
        [],
  );
}
