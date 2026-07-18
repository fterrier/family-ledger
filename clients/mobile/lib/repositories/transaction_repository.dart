import '../core/api_client.dart';
import '../core/api_error.dart';
import '../core/result.dart';
import '../models/doctor_issue.dart';
import '../models/transaction.dart';
import '../screens/transactions/transaction_filter.dart';

class TransactionRepository {
  final ApiClient _client;

  TransactionRepository(this._client);

  Future<Result<Map<String, dynamic>>> createTransaction(TransactionCreate tx) {
    return _client.post('/transactions', tx.toJson());
  }

  Future<Result<TransactionResource>> getTransaction(
    String name, {
    String? convert,
  }) async {
    final result = await _client.get(
      '/$name',
      queryParams: convert != null ? {'convert': convert} : null,
    );
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

  // One nonconforming issue (e.g. a future issue type/version skew) must
  // not blank every red indicator app-wide — skip just that entry.
  List<DoctorIssue> _parseIssues(Object? issuesJson) {
    final issues = <DoctorIssue>[];
    for (final entry in (issuesJson as List).cast<Map<String, dynamic>>()) {
      try {
        issues.add(DoctorIssue.fromJson(entry));
      } catch (_) {
        continue;
      }
    }
    return issues;
  }

  Future<Result<List<DoctorIssue>>> runDoctorIssues() async {
    final result = await _client.post('/ledger:doctor', {});
    if (result.error != null) return (data: null, error: result.error);
    return (data: _parseIssues(result.data!['issues']), error: null);
  }

  /// Previews issues (e.g. transaction_unbalanced) for a not-yet-saved
  /// edit, without persisting anything. The server computes balance via
  /// each posting's weight (cost/price-adjusted, not raw units) — the
  /// client never re-derives that rule itself.
  Future<Result<List<DoctorIssue>>> normalizeTransaction(
    TransactionUpdate tx,
  ) async {
    final result = await _client.post('/transactions:normalize', tx.toJson());
    if (result.error != null) return (data: null, error: result.error);
    return (data: _parseIssues(result.data!['issues']), error: null);
  }

  /// [convert] asks the server to value each foreign-currency posting's
  /// weight in that currency at the transaction date (`converted_weights`)
  /// — the app's default display currency, not a user filter.
  Future<Result<(List<TransactionResource>, String?)>> listTransactions({
    int pageSize = 100,
    String? pageToken,
    TransactionFilter? filter,
    String? convert,
  }) async {
    final params = <String, String>{'page_size': '$pageSize', 'order': 'desc'};
    if (pageToken != null) params['page_token'] = pageToken;
    if (filter != null) params.addAll(filter.toQueryParams());
    if (convert != null) params['convert'] = convert;

    final result = await _client.get('/transactions', queryParams: params);
    if (result.error != null) return (data: null, error: result.error);

    final body = result.data!;
    final transactions = (body['transactions'] as List)
        .map((e) => TransactionResource.fromJson(e as Map<String, dynamic>))
        .toList();
    final nextPageToken = body['next_page_token'] as String?;

    return (data: (transactions, nextPageToken), error: null);
  }

  Future<ApiError?> deleteTransaction(String name) => _client.delete('/$name');

  Future<Result<TransactionResource>> mergeTransactions(
    String primary,
    String secondary,
  ) async {
    final result = await _client.post('/transactions:merge', {
      'primary_transaction': primary,
      'secondary_transaction': secondary,
    });
    if (result.error != null) return (data: null, error: result.error);
    return (data: TransactionResource.fromJson(result.data!), error: null);
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
