import '../core/api_client.dart';
import '../core/result.dart';
import '../models/transaction.dart';
import '../screens/transactions/transaction_filter.dart';

class TransactionRepository {
  final ApiClient _client;

  TransactionRepository(this._client);

  Future<Result<Map<String, dynamic>>> createTransaction(TransactionCreate tx) {
    return _client.post('/transactions', tx.toJson());
  }

  Future<Result<TransactionResource>> getTransaction(String name) async {
    final result = await _client.get('/$name');
    if (result.error != null) return (data: null, error: result.error);
    return (data: TransactionResource.fromJson(result.data!), error: null);
  }

  Future<Result<TransactionResource>> updateTransaction(
    String name,
    TransactionUpdate tx,
  ) async {
    final result = await _client.patch('/$name', tx.toJson());
    if (result.error != null) return (data: null, error: result.error);
    return (data: TransactionResource.fromJson(result.data!), error: null);
  }

  Future<Result<Set<String>>> runDoctor() async {
    final result = await _client.post('/ledger:doctor', {});
    if (result.error != null) return (data: null, error: result.error);
    final issues = (result.data!['issues'] as List)
        .cast<Map<String, dynamic>>()
        .where((e) => e['target'] != null)
        .map((e) => e['target'] as String)
        .toSet();
    return (data: issues, error: null);
  }

  Future<Result<(List<TransactionResource>, String?)>> listTransactions({
    int pageSize = 100,
    String? pageToken,
    TransactionFilter? filter,
  }) async {
    final params = <String, String>{'page_size': '$pageSize', 'order': 'desc'};
    if (pageToken != null) params['page_token'] = pageToken;
    if (filter != null) params.addAll(filter.toQueryParams());

    final result = await _client.get('/transactions', queryParams: params);
    if (result.error != null) return (data: null, error: result.error);

    final body = result.data!;
    final transactions = (body['transactions'] as List)
        .map((e) => TransactionResource.fromJson(e as Map<String, dynamic>))
        .toList();
    final nextPageToken = body['next_page_token'] as String?;

    return (data: (transactions, nextPageToken), error: null);
  }

  Future<Result<(int, int)>> getYearRange() async {
    final results = await Future.wait([
      _client.get(
        '/transactions',
        queryParams: {'page_size': '1', 'order': 'asc'},
      ),
      _client.get(
        '/transactions',
        queryParams: {'page_size': '1', 'order': 'desc'},
      ),
    ]);
    for (final r in results) {
      if (r.error != null) return (data: null, error: r.error);
    }
    final oldest = results[0].data!['transactions'] as List;
    final newest = results[1].data!['transactions'] as List;
    final now = DateTime.now().year;
    if (oldest.isEmpty) return (data: (now, now), error: null);
    final oldestYear = DateTime.parse(
      (oldest.first as Map)['transaction_date'] as String,
    ).year;
    final newestYear = newest.isEmpty
        ? now
        : DateTime.parse(
            (newest.first as Map)['transaction_date'] as String,
          ).year;
    return (data: (oldestYear, newestYear), error: null);
  }
}
