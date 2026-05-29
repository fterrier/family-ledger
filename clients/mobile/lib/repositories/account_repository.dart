import '../core/api_client.dart';
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

    final all = <AccountResource>[];
    String? pageToken;

    do {
      final params = <String, String>{'page_size': '200'};
      if (pageToken != null) params['page_token'] = pageToken;

      final result = await _client.get('/accounts', queryParams: params);
      if (result.error != null) return (data: null, error: result.error);

      final body = result.data!;
      final items = (body['accounts'] as List)
          .map((e) => AccountResource.fromJson(e as Map<String, dynamic>))
          .toList();
      all.addAll(items);
      pageToken = body['next_page_token'] as String?;
    } while (pageToken != null);

    _cache = List<AccountResource>.unmodifiable(all);
    return (data: _cache!, error: null);
  }

  void invalidateCache() => _cache = null;
}
