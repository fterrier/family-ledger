import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_client.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/posting.dart';
import 'package:family_ledger_mobile/models/doctor_issue.dart';
import 'package:family_ledger_mobile/models/transaction.dart';
import 'package:family_ledger_mobile/repositories/transaction_repository.dart';
import 'package:family_ledger_mobile/screens/transactions/transaction_filter.dart';

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

  group('TransactionRepository.listTransactions', () {
    final txJson = <String, dynamic>{
      'name': 'transactions/t1',
      'transaction_date': '2026-06-01',
      'payee': 'Migros',
      'narration': 'Groceries',
      'postings': [
        {
          'account': 'accounts/acc_checking',
          'account_name': 'Assets:Bank:Checking',
          'units': {'amount': '-42.50', 'symbol': 'CHF'},
        },
        {
          'account': 'accounts/acc_food',
          'account_name': 'Expenses:Food',
          'units': {'amount': '42.50', 'symbol': 'CHF'},
        },
      ],
    };

    test(
      'fetches first page with order=desc and returns parsed transactions',
      () async {
        when(
          () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
        ).thenAnswer(
          (_) async => (
            data: <String, dynamic>{
              'transactions': [txJson],
              'next_page_token': 'token123',
            },
            error: null,
          ),
        );

        final result = await repo.listTransactions();

        expect(result.error, isNull);
        final (txs, nextToken) = result.data!;
        expect(txs, hasLength(1));
        expect(txs.first.payee, 'Migros');
        expect(txs.first.narration, 'Groceries');
        expect(txs.first.transactionDate, '2026-06-01');
        expect(txs.first.postings.first.units.amount, '-42.50');
        expect(nextToken, 'token123');

        final call = verify(
          () => mockClient.get(
            captureAny(),
            queryParams: captureAny(named: 'queryParams'),
          ),
        );
        call.called(1);
        final capturedParams = call.captured[1] as Map<String, String>;
        expect(capturedParams['order'], 'desc');
        expect(capturedParams['page_size'], '100');
      },
    );

    test('passes page_token when provided', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async => (
          data: <String, dynamic>{
            'transactions': <dynamic>[],
            'next_page_token': null,
          },
          error: null,
        ),
      );

      await repo.listTransactions(pageToken: 'mytoken');

      final call = verify(
        () => mockClient.get(
          captureAny(),
          queryParams: captureAny(named: 'queryParams'),
        ),
      );
      final capturedParams = call.captured[1] as Map<String, String>;
      expect(capturedParams['page_token'], 'mytoken');
    });

    test('propagates auth error from client', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      final result = await repo.listTransactions();

      expect(result.error, isA<AuthError>());
      expect(result.data, isNull);
    });
  });

  group('TransactionRepository.getTransaction', () {
    final txJson = <String, dynamic>{
      'name': 'transactions/t1',
      'transaction_date': '2026-06-01',
      'payee': 'Migros',
      'narration': null,
      'postings': [
        {
          'account': 'accounts/acc_checking',
          'account_name': 'Assets:Bank:Checking',
          'units': {'amount': '-42.50', 'symbol': 'CHF'},
        },
      ],
    };

    test(
      'fetches from /transactions/{name} and returns parsed resource',
      () async {
        when(
          () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
        ).thenAnswer((_) async => (data: txJson, error: null));

        final result = await repo.getTransaction('transactions/t1');

        expect(result.error, isNull);
        expect(result.data?.name, 'transactions/t1');
        expect(result.data?.payee, 'Migros');
        expect(result.data?.postings.first.units.amount, '-42.50');

        final call = verify(
          () => mockClient.get(
            captureAny(),
            queryParams: captureAny(named: 'queryParams'),
          ),
        );
        call.called(1);
        expect(call.captured[0], '/transactions/t1');
      },
    );

    test('propagates auth error from client', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      final result = await repo.getTransaction('transactions/t1');

      expect(result.error, isA<AuthError>());
      expect(result.data, isNull);
    });
  });

  group('TransactionRepository.updateTransaction', () {
    final updatedJson = <String, dynamic>{
      'name': 'transactions/t1',
      'transaction_date': '2026-06-01',
      'payee': 'Migros Updated',
      'narration': null,
      'postings': [
        {
          'account': 'accounts/acc_checking',
          'account_name': 'Assets:Bank:Checking',
          'units': {'amount': '-50.00', 'symbol': 'CHF'},
        },
      ],
    };

    const update = TransactionUpdate(
      transactionDate: '2026-06-01',
      payee: 'Migros Updated',
      postings: [
        PostingPayload(
          account: 'accounts/acc_checking',
          units: MoneyValue(amount: '-50.00', symbol: 'CHF'),
        ),
      ],
    );

    test('patches /transactions/{name} and returns updated resource', () async {
      when(
        () => mockClient.patch(any(), any()),
      ).thenAnswer((_) async => (data: updatedJson, error: null));

      final result = await repo.updateTransaction('transactions/t1', update);

      expect(result.error, isNull);
      expect(result.data?.name, 'transactions/t1');
      expect(result.data?.payee, 'Migros Updated');

      final call = verify(() => mockClient.patch(captureAny(), captureAny()));
      call.called(1);
      final args = call.captured;
      expect(args[0], '/transactions/t1');
      expect((args[1] as Map)['transaction'], isA<Map>());
    });

    test('propagates validation error from client', () async {
      when(() => mockClient.patch(any(), any())).thenAnswer(
        (_) async =>
            (data: null, error: const ValidationError('invalid amount')),
      );

      final result = await repo.updateTransaction('transactions/t1', update);

      expect(result.error, isA<ValidationError>());
      expect(result.data, isNull);
    });

    test('propagates network error from client', () async {
      when(() => mockClient.patch(any(), any())).thenAnswer(
        (_) async => (data: null, error: const NetworkError('timeout')),
      );

      final result = await repo.updateTransaction('transactions/t1', update);

      expect(result.error, isA<NetworkError>());
    });
  });

  group('TransactionRepository.runDoctor', () {
    test(
      'posts to /ledger:doctor and returns set of transaction names',
      () async {
        when(() => mockClient.post(any(), any())).thenAnswer(
          (_) async => (
            data: <String, dynamic>{
              'issues': [
                {
                  'target': 'transactions/t1',
                  'code': 'UNBALANCED',
                  'severity': 'error',
                  'message': 'msg',
                },
                {
                  'target': 'transactions/t2',
                  'code': 'UNKNOWN_COMMODITY',
                  'severity': 'warning',
                  'message': 'msg',
                },
              ],
            },
            error: null,
          ),
        );

        final result = await repo.runDoctor();

        expect(result.error, isNull);
        expect(result.data, {'transactions/t1', 'transactions/t2'});

        final call = verify(() => mockClient.post(captureAny(), captureAny()));
        call.called(1);
        expect(call.captured[0], '/ledger:doctor');
      },
    );

    test('excludes issues with null target', () async {
      when(() => mockClient.post(any(), any())).thenAnswer(
        (_) async => (
          data: <String, dynamic>{
            'issues': [
              {
                'target': 'transactions/t1',
                'code': 'UNBALANCED',
                'severity': 'error',
                'message': 'msg',
              },
              {
                'target': null,
                'code': 'BALANCE_ASSERTION_FAILED',
                'severity': 'error',
                'message': 'msg',
              },
            ],
          },
          error: null,
        ),
      );

      final result = await repo.runDoctor();

      expect(result.data, {'transactions/t1'});
    });

    test('returns empty set when there are no issues', () async {
      when(() => mockClient.post(any(), any())).thenAnswer(
        (_) async =>
            (data: <String, dynamic>{'issues': <dynamic>[]}, error: null),
      );

      final result = await repo.runDoctor();

      expect(result.data, isEmpty);
    });

    test('propagates error from client', () async {
      when(() => mockClient.post(any(), any())).thenAnswer(
        (_) async => (data: null, error: const NetworkError('timeout')),
      );

      final result = await repo.runDoctor();

      expect(result.error, isA<NetworkError>());
      expect(result.data, isNull);
    });
  });

  group('TransactionRepository.listTransactions with filter', () {
    final emptyResponse = <String, dynamic>{
      'transactions': <dynamic>[],
      'next_page_token': null,
    };

    const account = AccountResource(
      name: 'accounts/acc_checking',
      accountName: 'Assets:Bank:Checking',
      effectiveStartDate: '2020-01-01',
    );

    test('passes account param when filter has account', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: emptyResponse, error: null));

      await repo.listTransactions(
        filter: const TransactionFilter(account: account),
      );

      final call = verify(
        () => mockClient.get(
          captureAny(),
          queryParams: captureAny(named: 'queryParams'),
        ),
      );
      call.called(1);
      final params = call.captured[1] as Map<String, String>;
      expect(params['account_name'], 'Assets:Bank:Checking');
    });

    test('passes from_date and to_date for date range', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: emptyResponse, error: null));

      await repo.listTransactions(
        filter: TransactionFilter(
          fromDate: DateTime(2025),
          toDate: DateTime(2025, 12, 31),
        ),
      );

      final call = verify(
        () => mockClient.get(
          captureAny(),
          queryParams: captureAny(named: 'queryParams'),
        ),
      );
      call.called(1);
      final params = call.captured[1] as Map<String, String>;
      expect(params['from_date'], '2025-01-01');
      expect(params['to_date'], '2025-12-31');
    });

    test('does not add filter params when filter is inactive', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: emptyResponse, error: null));

      await repo.listTransactions(filter: const TransactionFilter());

      final call = verify(
        () => mockClient.get(
          captureAny(),
          queryParams: captureAny(named: 'queryParams'),
        ),
      );
      call.called(1);
      final params = call.captured[1] as Map<String, String>;
      expect(params.containsKey('account'), isFalse);
      expect(params.containsKey('from_date'), isFalse);
      expect(params.containsKey('to_date'), isFalse);
    });
  });

  group('TransactionRepository.getYearRange', () {
    final txJson2020 = <String, dynamic>{
      'name': 'transactions/t_old',
      'transaction_date': '2020-03-15',
      'postings': <dynamic>[],
    };
    final txJson2025 = <String, dynamic>{
      'name': 'transactions/t_new',
      'transaction_date': '2025-11-20',
      'postings': <dynamic>[],
    };

    test(
      'returns (oldestYear, newestYear) from two parallel requests',
      () async {
        var callCount = 0;
        when(
          () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
        ).thenAnswer((inv) async {
          final params =
              inv.namedArguments[#queryParams] as Map<String, String>;
          callCount++;
          if (params['order'] == 'asc') {
            return (
              data: <String, dynamic>{
                'transactions': [txJson2020],
                'next_page_token': null,
              },
              error: null,
            );
          }
          return (
            data: <String, dynamic>{
              'transactions': [txJson2025],
              'next_page_token': null,
            },
            error: null,
          );
        });

        final result = await repo.getYearRange();

        expect(callCount, 2);
        expect(result.error, isNull);
        expect(result.data, (2020, 2025));
      },
    );

    test('returns (currentYear, currentYear) when no transactions', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async => (
          data: <String, dynamic>{
            'transactions': <dynamic>[],
            'next_page_token': null,
          },
          error: null,
        ),
      );

      final result = await repo.getYearRange();

      expect(result.error, isNull);
      expect(result.data!.$1, DateTime.now().year);
      expect(result.data!.$2, DateTime.now().year);
    });

    test('propagates error from client', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async => (data: null, error: const NetworkError('timeout')),
      );

      final result = await repo.getYearRange();

      expect(result.error, isA<NetworkError>());
      expect(result.data, isNull);
    });
  });

  group('TransactionRepository.deleteTransaction', () {
    test('calls delete on /{name} and returns null on success', () async {
      when(() => mockClient.delete(any())).thenAnswer((_) async => null);

      final error = await repo.deleteTransaction('transactions/t1');

      expect(error, isNull);

      final call = verify(() => mockClient.delete(captureAny()));
      call.called(1);
      expect(call.captured.single, '/transactions/t1');
    });

    test('propagates error from client', () async {
      when(
        () => mockClient.delete(any()),
      ).thenAnswer((_) async => const NetworkError('timeout'));

      final error = await repo.deleteTransaction('transactions/t1');

      expect(error, isA<NetworkError>());
    });
  });

  group('TransactionRepository.mergeTransactions', () {
    final mergedJson = <String, dynamic>{
      'name': 'transactions/merged',
      'transaction_date': '2026-06-01',
      'payee': 'Migros',
      'narration': null,
      'postings': [
        {
          'account': 'accounts/acc_checking',
          'account_name': 'Assets:Bank:Checking',
          'units': {'amount': '-42.50', 'symbol': 'CHF'},
        },
      ],
    };

    test('posts to /transactions:merge and returns parsed resource', () async {
      when(
        () => mockClient.post(any(), any()),
      ).thenAnswer((_) async => (data: mergedJson, error: null));

      final result = await repo.mergeTransactions(
        'transactions/t1',
        'transactions/t2',
      );

      expect(result.error, isNull);
      expect(result.data?.name, 'transactions/merged');
      expect(result.data?.payee, 'Migros');

      final call = verify(() => mockClient.post(captureAny(), captureAny()));
      call.called(1);
      final args = call.captured;
      expect(args[0], '/transactions:merge');
      expect((args[1] as Map)['primary_transaction'], 'transactions/t1');
      expect((args[1] as Map)['secondary_transaction'], 'transactions/t2');
    });

    test('propagates error from client', () async {
      when(() => mockClient.post(any(), any())).thenAnswer(
        (_) async => (data: null, error: const NetworkError('timeout')),
      );

      final result = await repo.mergeTransactions(
        'transactions/t1',
        'transactions/t2',
      );

      expect(result.error, isA<NetworkError>());
      expect(result.data, isNull);
    });
  });
  group('TransactionRepository.runDoctorIssues', () {
    test('parses full issues including details and target summary', () async {
      final mockClient = MockApiClient();
      final repo = TransactionRepository(mockClient);
      when(() => mockClient.post(any(), any())).thenAnswer(
        (_) async => (
          data: {
            'issues': [
              {
                'target': 'balanceAssertions/ba-1',
                'code': 'balance_assertion_failed',
                'severity': 'error',
                'message': 'Balance assertion not satisfied.',
                'details': {'symbol': 'CHF', 'diff': '-1.50'},
                'target_summary': {
                  'date': '2026-01-05',
                  'account': 'Assets:Liquid:ZKB:Checking:Family',
                },
              },
              {
                'target': null,
                'code': 'attachment_pending_upload',
                'severity': 'error',
                'message': 'pending',
              },
            ],
          },
          error: null,
        ),
      );

      final result = await repo.runDoctorIssues();

      expect(result.error, isNull);
      expect(result.data, hasLength(2));
      final assertion = result.data![0];
      expect(assertion.code, DoctorIssue.balanceAssertionFailed);
      expect(assertion.accountName, 'Assets:Liquid:ZKB:Checking:Family');
      expect(assertion.date, DateTime(2026, 1, 5));
      expect(assertion.details['diff'], '-1.50');
      expect(result.data![1].target, isNull);
    });

    test(
      'one malformed issue is skipped, not fatal to the whole batch',
      () async {
        final mockClient = MockApiClient();
        final repo = TransactionRepository(mockClient);
        when(() => mockClient.post(any(), any())).thenAnswer(
          (_) async => (
            data: {
              'issues': [
                {
                  'target': 'transactions/t1',
                  'code': 'unbalanced_transaction',
                  'severity': 'error',
                  'message': 'off by 0.01',
                },
                // Missing required 'code' — version-skew / malformed entry.
                {'target': 'transactions/t2', 'severity': 'error'},
                {
                  'target': 'transactions/t3',
                  'code': 'unbalanced_transaction',
                  'severity': 'error',
                  'message': 'off by 0.02',
                },
              ],
            },
            error: null,
          ),
        );

        final result = await repo.runDoctorIssues();

        expect(result.error, isNull);
        expect(result.data!.map((i) => i.target), [
          'transactions/t1',
          'transactions/t3',
        ]);
      },
    );
  });
}
