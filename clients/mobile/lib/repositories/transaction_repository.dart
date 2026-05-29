import '../core/api_client.dart';
import '../core/result.dart';
import '../models/transaction.dart';

class TransactionRepository {
  final ApiClient _client;

  TransactionRepository(this._client);

  Future<Result<Map<String, dynamic>>> createTransaction(TransactionCreate tx) {
    return _client.post('/transactions', tx.toJson());
  }
}
