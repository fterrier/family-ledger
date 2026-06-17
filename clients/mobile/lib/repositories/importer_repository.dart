import 'dart:typed_data';
import '../core/api_client.dart';
import '../core/result.dart';
import '../models/import_result.dart';
import '../models/importer.dart';

class ImporterRepository {
  final ApiClient _client;

  ImporterRepository(this._client);

  Future<Result<List<Importer>>> getImporters() async {
    final result = await _client.get('/importers');
    if (result.error != null) return (data: null, error: result.error);
    final list = (result.data!['importers'] as List<dynamic>)
        .map((e) => Importer.fromJson(e as Map<String, dynamic>))
        .toList();
    return (data: list, error: null);
  }

  Future<Result<ImportResult>> importFile({
    required String importerName,
    required String fieldName,
    required String filename,
    required Uint8List fileBytes,
    String? mimeType,
  }) async {
    final result = await _client.postMultipart(
      '/importers/$importerName:import',
      files: {fieldName: (fileBytes, filename)},
      mimeType: mimeType,
    );
    if (result.error != null) return (data: null, error: result.error);
    return (
      data: ImportResult.fromJson(
        result.data!['result'] as Map<String, dynamic>,
      ),
      error: null,
    );
  }
}
