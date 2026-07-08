import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_client.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/query_result.dart';
import 'package:family_ledger_mobile/repositories/query_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient mockClient;
  late QueryRepository repo;

  setUp(() {
    mockClient = MockApiClient();
    repo = QueryRepository(mockClient);
  });

  test('posts the query string to /ledger:query', () async {
    when(() => mockClient.post(any(), any())).thenAnswer(
      (_) async =>
          (data: {'columns': [], 'rows': [], 'warnings': []}, error: null),
    );

    await repo.run('SELECT count(*) AS n');

    verify(
      () => mockClient.post('/ledger:query', {'query': 'SELECT count(*) AS n'}),
    ).called(1);
  });

  test('decodes inventory cells (balance series)', () async {
    when(() => mockClient.post(any(), any())).thenAnswer(
      (_) async => (
        data: {
          'columns': [
            {'name': 'y', 'type': 'int'},
            {'name': 'm', 'type': 'int'},
            {'name': 'bal', 'type': 'inventory'},
          ],
          'rows': [
            [
              2025,
              7,
              [
                {'number': '5800', 'currency': 'CHF'},
              ],
            ],
            [
              2025,
              8,
              [
                {'number': '4000', 'currency': 'CHF'},
                {'number': '50', 'currency': 'USD'},
              ],
            ],
          ],
          'warnings': [],
        },
        error: null,
      ),
    );

    final result = await repo.run('q');

    expect(result.error, isNull);
    final rows = result.data!.rows;
    expect(rows[0], [
      2025,
      7,
      [const QueryAmount(number: '5800', currency: 'CHF')],
    ]);
    expect(rows[1][2], [
      const QueryAmount(number: '4000', currency: 'CHF'),
      const QueryAmount(number: '50', currency: 'USD'),
    ]);
  });

  test('decodes amount cells, null cells, and warnings', () async {
    when(() => mockClient.post(any(), any())).thenAnswer(
      (_) async => (
        data: {
          'columns': [
            {'name': 'y', 'type': 'int'},
            {'name': 'bal', 'type': 'amount'},
          ],
          'rows': [
            [
              2025,
              {'number': '5800', 'currency': 'CHF'},
            ],
            [2026, null],
          ],
          'warnings': [
            {
              'code': 'missing_price',
              'message': 'No CHF price for USD on or before 2026-12-31.',
              'details': {'base': 'USD', 'quote': 'CHF', 'date': '2026-12-31'},
            },
          ],
        },
        error: null,
      ),
    );

    final result = await repo.run('q');

    expect(
      result.data!.rows[0][1],
      const QueryAmount(number: '5800', currency: 'CHF'),
    );
    expect(result.data!.rows[1][1], isNull);
    expect(result.data!.warnings, hasLength(1));
    expect(result.data!.warnings[0].code, 'missing_price');
    expect(result.data!.warnings[0].details['base'], 'USD');
  });

  test('decodes journal cells: date, str, decimal', () async {
    when(() => mockClient.post(any(), any())).thenAnswer(
      (_) async => (
        data: {
          'columns': [
            {'name': 'date', 'type': 'date'},
            {'name': 'account', 'type': 'str'},
            {'name': 'payee', 'type': 'str'},
            {'name': 'number', 'type': 'decimal'},
          ],
          'rows': [
            ['2025-07-20', 'Expenses:Groceries', null, '200'],
          ],
          'warnings': [],
        },
        error: null,
      ),
    );

    final result = await repo.run('q');

    expect(result.data!.rows[0], [
      DateTime(2025, 7, 20),
      'Expenses:Groceries',
      null,
      '200',
    ]);
  });

  test('passes unknown column types through untouched', () async {
    when(() => mockClient.post(any(), any())).thenAnswer(
      (_) async => (
        data: {
          'columns': [
            {'name': 'x', 'type': 'hologram'},
          ],
          'rows': [
            [
              {'weird': true},
            ],
          ],
          'warnings': [],
        },
        error: null,
      ),
    );

    final result = await repo.run('q');

    expect(result.error, isNull);
    expect(result.data!.rows[0][0], {'weird': true});
  });

  test('propagates API errors', () async {
    when(() => mockClient.post(any(), any())).thenAnswer(
      (_) async => (data: null, error: const ValidationError('bad query')),
    );

    final result = await repo.run('SELECT nope');

    expect(result.data, isNull);
    expect(result.error, isA<ValidationError>());
  });

  test('malformed response surfaces as ValidationError, not a crash', () async {
    when(
      () => mockClient.post(any(), any()),
    ).thenAnswer((_) async => (data: {'columns': 'not-a-list'}, error: null));

    final result = await repo.run('q');

    expect(result.data, isNull);
    expect(result.error, isA<ValidationError>());
  });
}
