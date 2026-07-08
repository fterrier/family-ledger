import '../core/api_client.dart';
import '../core/api_error.dart';
import '../core/result.dart';
import '../models/query_result.dart';

class QueryRepository {
  final ApiClient _client;

  QueryRepository(this._client);

  Future<Result<QueryResult>> run(String query) async {
    final result = await _client.post('/ledger:query', {'query': query});
    if (result.error != null) return (data: null, error: result.error);
    try {
      return (data: QueryResult.fromJson(result.data!), error: null);
    } catch (e) {
      return (
        data: null,
        error: ValidationError('Malformed query response: $e'),
      );
    }
  }
}
