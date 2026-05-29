import '../core/api_client.dart';
import '../core/result.dart';
import '../models/commodity.dart';

class CommodityRepository {
  final ApiClient _client;
  List<Commodity>? _cache;

  CommodityRepository(this._client);

  Future<Result<List<Commodity>>> getAllCommodities({
    bool forceRefresh = false,
  }) async {
    if (!forceRefresh && _cache != null) {
      return (data: _cache!, error: null);
    }

    final all = <Commodity>[];
    String? pageToken;

    do {
      final params = <String, String>{'page_size': '200'};
      if (pageToken != null) params['page_token'] = pageToken;

      final result = await _client.get('/commodities', queryParams: params);
      if (result.error != null) return (data: null, error: result.error);

      final body = result.data!;
      final items = (body['commodities'] as List)
          .map((e) => Commodity.fromJson(e as Map<String, dynamic>))
          .toList();
      all.addAll(items);
      pageToken = body['next_page_token'] as String?;
    } while (pageToken != null);

    _cache = List<Commodity>.unmodifiable(all);
    return (data: _cache!, error: null);
  }

  void invalidateCache() => _cache = null;
}
