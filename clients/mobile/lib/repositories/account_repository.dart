import '../core/api_client.dart';
import '../core/paginated_fetch.dart';
import '../core/result.dart';
import '../models/account.dart';

class AccountRepository {
  final ApiClient _client;
  List<AccountResource>? _cache;

  AccountRepository(this._client);

  Future<Result<List<AccountResource>>> getAllAccounts({
    bool forceRefresh = false,
  }) async {
    if (!forceRefresh && _cache != null) {
      return (data: _cache!, error: null);
    }
    final result = await paginatedFetch(
      _client,
      '/accounts',
      'accounts',
      AccountResource.fromJson,
    );
    if (result.error != null) return result;
    _cache = List<AccountResource>.unmodifiable(result.data!);
    return (data: _cache!, error: null);
  }

  void invalidateCache() => _cache = null;
}
