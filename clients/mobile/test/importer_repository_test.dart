import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_client.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/repositories/importer_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

const _importersResponse = <String, dynamic>{
  'importers': [
    {
      'name': 'importers/mt940',
      'plugin_name': 'mt940',
      'display_name': 'MT940',
      'config': <String, dynamic>{},
      'schema': <String, dynamic>{},
      'file_descriptors': [
        {
          'name': 'statement',
          'label': 'Statement file',
          'accept': ['.sta', '.mt940'],
          'required': true,
        },
      ],
    },
    {
      'name': 'importers/beancount',
      'plugin_name': 'beancount',
      'display_name': 'Beancount',
      'config': <String, dynamic>{},
      'schema': <String, dynamic>{},
      'file_descriptors': [],
    },
  ],
};

const _importResultResponse = <String, dynamic>{
  'result': {
    'entities': {
      'transaction': {
        'created': 12,
        'duplicate': 3,
        'errors': {
          'count': 1,
          'examples': ['Parse error on line 45'],
        },
      },
    },
    'warnings': ['Paperless not configured'],
    'created_resources': <String, dynamic>{},
  },
};

void main() {
  late MockApiClient mockClient;
  late ImporterRepository repo;

  setUp(() {
    mockClient = MockApiClient();
    repo = ImporterRepository(mockClient);

    registerFallbackValue(<String, (Uint8List, String)>{});
  });

  group('ImporterRepository.getImporters', () {
    test('GETs /importers and parses importer list', () async {
      when(
        () => mockClient.get(
          '/importers',
          queryParams: any(named: 'queryParams'),
        ),
      ).thenAnswer((_) async => (data: _importersResponse, error: null));

      final result = await repo.getImporters();

      expect(result.error, isNull);
      expect(result.data, hasLength(2));
      expect(result.data![0].pluginName, 'mt940');
      expect(result.data![0].displayName, 'MT940');
      expect(result.data![0].fileDescriptors, hasLength(1));
      expect(result.data![0].fileDescriptors[0].name, 'statement');
      expect(result.data![1].pluginName, 'beancount');
    });

    test('propagates auth error', () async {
      when(
        () => mockClient.get(
          '/importers',
          queryParams: any(named: 'queryParams'),
        ),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      final result = await repo.getImporters();

      expect(result.error, isA<AuthError>());
      expect(result.data, isNull);
    });

    test('propagates network error', () async {
      when(
        () => mockClient.get(
          '/importers',
          queryParams: any(named: 'queryParams'),
        ),
      ).thenAnswer(
        (_) async => (data: null, error: const NetworkError('unreachable')),
      );

      final result = await repo.getImporters();

      expect(result.error, isA<NetworkError>());
    });
  });

  group('ImporterRepository.importFile', () {
    final fakeBytes = Uint8List.fromList([1, 2, 3]);

    test(
      'POSTs multipart to /importers/{name}:import and parses result',
      () async {
        when(
          () => mockClient.postMultipart(
            any(),
            files: any(named: 'files'),
            configOverrideJson: any(named: 'configOverrideJson'),
          ),
        ).thenAnswer((_) async => (data: _importResultResponse, error: null));

        final result = await repo.importFile(
          importerName: 'importers/mt940',
          fieldName: 'statement',
          filename: 'bank.sta',
          fileBytes: fakeBytes,
        );

        expect(result.error, isNull);
        expect(result.data, isNotNull);
        expect(result.data!.entities['transaction']!.created, 12);
        expect(result.data!.entities['transaction']!.duplicate, 3);
        expect(result.data!.entities['transaction']!.errorCount, 1);
        expect(result.data!.entities['transaction']!.errorExamples, [
          'Parse error on line 45',
        ]);
        expect(result.data!.warnings, ['Paperless not configured']);

        final captured = verify(
          () => mockClient.postMultipart(
            captureAny(),
            files: captureAny(named: 'files'),
            configOverrideJson: any(named: 'configOverrideJson'),
          ),
        ).captured;
        expect(captured[0], '/importers/importers/mt940:import');
        final files = captured[1] as Map<String, (Uint8List, String)>;
        expect(files.keys.first, 'statement');
        expect(files.values.first.$2, 'bank.sta');
      },
    );

    test('uses "file" as field name when no file descriptors', () async {
      when(
        () => mockClient.postMultipart(
          any(),
          files: any(named: 'files'),
          configOverrideJson: any(named: 'configOverrideJson'),
        ),
      ).thenAnswer((_) async => (data: _importResultResponse, error: null));

      await repo.importFile(
        importerName: 'importers/beancount',
        fieldName: 'file',
        filename: 'ledger.beancount',
        fileBytes: fakeBytes,
      );

      final captured = verify(
        () => mockClient.postMultipart(
          captureAny(),
          files: captureAny(named: 'files'),
          configOverrideJson: any(named: 'configOverrideJson'),
        ),
      ).captured;
      final files = captured[1] as Map<String, (Uint8List, String)>;
      expect(files.keys.first, 'file');
    });

    test('propagates server error', () async {
      when(
        () => mockClient.postMultipart(
          any(),
          files: any(named: 'files'),
          configOverrideJson: any(named: 'configOverrideJson'),
        ),
      ).thenAnswer(
        (_) async => (
          data: null,
          error: const ServerError(
            500,
            'internal_error',
            'Internal server error',
          ),
        ),
      );

      final result = await repo.importFile(
        importerName: 'importers/mt940',
        fieldName: 'statement',
        filename: 'bank.sta',
        fileBytes: fakeBytes,
      );

      expect(result.error, isA<ServerError>());
      expect(result.data, isNull);
    });
  });
}
