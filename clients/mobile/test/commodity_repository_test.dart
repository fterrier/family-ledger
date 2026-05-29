import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_client.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/repositories/commodity_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  group('Commodity.fromJson', () {
    test('parses symbol and name', () {
      final c = Commodity.fromJson({
        'name': 'commodities/chf',
        'symbol': 'CHF',
      });
      expect(c.name, 'commodities/chf');
      expect(c.symbol, 'CHF');
    });
  });

  group('CommodityRepository.getAllCommodities', () {
    late MockApiClient mockClient;
    late CommodityRepository repo;

    setUp(() {
      mockClient = MockApiClient();
      repo = CommodityRepository(mockClient);
    });

    test('returns commodities on success', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async => (
          data: {
            'commodities': [
              {'name': 'commodities/chf', 'symbol': 'CHF'},
              {'name': 'commodities/eur', 'symbol': 'EUR'},
            ],
            'next_page_token': null,
          },
          error: null,
        ),
      );

      final result = await repo.getAllCommodities();

      expect(result.error, isNull);
      expect(result.data, hasLength(2));
      expect(result.data!.map((c) => c.symbol), containsAll(['CHF', 'EUR']));
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
            'commodities': [
              {'name': 'commodities/chf', 'symbol': 'CHF'},
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
            'commodities': [
              {'name': 'commodities/eur', 'symbol': 'EUR'},
            ],
            'next_page_token': null,
          },
          error: null,
        ),
      );

      final result = await repo.getAllCommodities();

      expect(result.data, hasLength(2));
      expect(result.data!.map((c) => c.symbol), containsAll(['CHF', 'EUR']));
    });

    test('returns cached result on second call', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async => (
          data: {
            'commodities': [
              {'name': 'commodities/chf', 'symbol': 'CHF'},
            ],
            'next_page_token': null,
          },
          error: null,
        ),
      );

      await repo.getAllCommodities();
      await repo.getAllCommodities();

      verify(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).called(1);
    });

    test('refetches after invalidateCache', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer(
        (_) async =>
            (data: {'commodities': [], 'next_page_token': null}, error: null),
      );

      await repo.getAllCommodities();
      repo.invalidateCache();
      await repo.getAllCommodities();

      verify(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).called(2);
    });

    test('propagates API error', () async {
      when(
        () => mockClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      final result = await repo.getAllCommodities();

      expect(result.error, isA<AuthError>());
      expect(result.data, isNull);
    });
  });
}
