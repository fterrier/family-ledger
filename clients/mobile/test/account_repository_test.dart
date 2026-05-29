import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_client.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/repositories/account_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient mockClient;
  late AccountRepository repo;

  setUp(() {
    mockClient = MockApiClient();
    repo = AccountRepository(mockClient);
  });

  group('AccountRepository.getAllAccounts', () {
    test('returns accounts on success', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async => (
          data: {
            'accounts': [
              {
                'name': 'accounts/acc_1',
                'account_name': 'Assets:Cash:Wallet',
                'effective_start_date': '2020-01-01',
                'effective_end_date': null,
              },
            ],
            'next_page_token': null,
          },
          error: null,
        ),
      );

      final result = await repo.getAllAccounts();

      expect(result.error, isNull);
      expect(result.data, hasLength(1));
      expect(result.data!.first.accountName, 'Assets:Cash:Wallet');
    });

    test('follows pagination until next_page_token is null', () async {
      when(
        () => mockClient.get(
          any(),
          queryParams: any(
            named: 'queryParams',
            that: predicate<Map<String, String>>(
              (m) => !m.containsKey('page_token'),
            ),
          ),
        ),
      ).thenAnswer(
        (_) async => (
          data: {
            'accounts': [
              {
                'name': 'accounts/acc_1',
                'account_name': 'Assets:Cash',
                'effective_start_date': '2020-01-01',
                'effective_end_date': null,
              },
            ],
            'next_page_token': 'page2token',
          },
          error: null,
        ),
      );

      when(
        () => mockClient.get(
          any(),
          queryParams: any(
            named: 'queryParams',
            that: predicate<Map<String, String>>(
              (m) => m['page_token'] == 'page2token',
            ),
          ),
        ),
      ).thenAnswer(
        (_) async => (
          data: {
            'accounts': [
              {
                'name': 'accounts/acc_2',
                'account_name': 'Expenses:Food',
                'effective_start_date': '2020-01-01',
                'effective_end_date': null,
              },
            ],
            'next_page_token': null,
          },
          error: null,
        ),
      );

      final result = await repo.getAllAccounts();

      expect(result.data, hasLength(2));
      expect(
        result.data!.map((a) => a.accountName),
        containsAll(['Assets:Cash', 'Expenses:Food']),
      );
    });

    test('returns cached result on second call without forceRefresh', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async => (
          data: {
            'accounts': [
              {
                'name': 'accounts/acc_1',
                'account_name': 'Assets:Cash',
                'effective_start_date': '2020-01-01',
                'effective_end_date': null,
              },
            ],
            'next_page_token': null,
          },
          error: null,
        ),
      );

      await repo.getAllAccounts();
      await repo.getAllAccounts();

      verify(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).called(1);
    });

    test('refetches after invalidateCache', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async =>
            (data: {'accounts': [], 'next_page_token': null}, error: null),
      );

      await repo.getAllAccounts();
      repo.invalidateCache();
      await repo.getAllAccounts();

      verify(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).called(2);
    });

    test('propagates API error', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      final result = await repo.getAllAccounts();

      expect(result.error, isA<AuthError>());
      expect(result.data, isNull);
    });
  });
}
