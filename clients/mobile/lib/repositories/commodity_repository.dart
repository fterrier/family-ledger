import '../core/api_client.dart';
import '../core/paginated_fetch.dart';
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
    final result = await paginatedFetch(
      _client,
      '/commodities',
      'commodities',
      Commodity.fromJson,
    );
    if (result.error != null) return result;
    _cache = List<Commodity>.unmodifiable(result.data!);
    return (data: _cache!, error: null);
  }

  void invalidateCache() => _cache = null;
}
