import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_client.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/posting.dart';
import 'package:family_ledger_mobile/models/transaction.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

const _tx = TransactionCreate(
  transactionDate: '2026-05-28',
  payee: 'Migros',
  postings: [
    PostingPayload(
      account: 'accounts/acc_from',
      units: MoneyValue(amount: '-42.50', symbol: 'CHF'),
    ),
    PostingPayload(
      account: 'accounts/acc_to',
      units: MoneyValue(amount: '42.50', symbol: 'CHF'),
    ),
  ],
);

void main() {
  late MockApiClient mockClient;
  late TransactionRepository repo;

  setUp(() {
    mockClient = MockApiClient();
    repo = TransactionRepository(mockClient);
  });

  group('TransactionRepository.createTransaction', () {
    test('posts to /transactions and returns success', () async {
      when(() => mockClient.post(any(), any())).thenAnswer(
        (_) async =>
            (data: <String, dynamic>{'name': 'transactions/t1'}, error: null),
      );

      final result = await repo.createTransaction(_tx);

      expect(result.error, isNull);
      expect(result.data, isNotNull);

      final call = verify(() => mockClient.post(captureAny(), captureAny()));
      call.called(1);
      final args = call.captured;
      expect(args[0], '/transactions');
      expect((args[1] as Map)['transaction'], isA<Map>());
    });

    test('propagates auth error from client', () async {
      when(
        () => mockClient.post(any(), any()),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      final result = await repo.createTransaction(_tx);

      expect(result.error, isA<AuthError>());
      expect(result.data, isNull);
    });

    test('propagates validation error from client', () async {
      when(() => mockClient.post(any(), any())).thenAnswer(
        (_) async =>
            (data: null, error: const ValidationError('Invalid amount')),
      );

      final result = await repo.createTransaction(_tx);

      expect(result.error, isA<ValidationError>());
    });
  });
}
