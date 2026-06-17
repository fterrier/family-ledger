import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/models/import_result.dart';
import 'package:family_ledger_mobile/models/importer.dart';
import 'package:family_ledger_mobile/repositories/importer_repository.dart';
import 'package:family_ledger_mobile/screens/import/import_screen.dart';
import 'package:family_ledger_mobile/widgets/error_banner.dart';

class MockImporterRepository extends Mock implements ImporterRepository {}

const _mt940 = Importer(
  name: 'importers/mt940',
  pluginName: 'mt940',
  displayName: 'MT940',
  fileDescriptors: [
    FileDescriptor(
      name: 'statement',
      label: 'Statement file',
      accept: ['.sta'],
      required: true,
    ),
  ],
);

const _beancount = Importer(
  name: 'importers/beancount',
  pluginName: 'beancount',
  displayName: 'Beancount',
  fileDescriptors: [],
);

const _result = ImportResult(
  entities: {
    'transaction': EntityCounts(
      created: 12,
      duplicate: 3,
      errorCount: 0,
      errorExamples: [],
    ),
  },
  warnings: [],
);

const _resultWithErrors = ImportResult(
  entities: {
    'transaction': EntityCounts(
      created: 2,
      duplicate: 0,
      errorCount: 1,
      errorExamples: ['Parse error on line 45'],
    ),
  },
  warnings: ['Paperless not configured'],
);

void main() {
  late MockImporterRepository mockRepo;

  setUp(() {
    mockRepo = MockImporterRepository();
    registerFallbackValue(Uint8List(0));
  });

  Widget buildScreen({String? filePath, VoidCallback? onOpenSettings}) =>
      MaterialApp(
        home: ImportScreen(
          importerRepository: mockRepo,
          onOpenSettings: onOpenSettings,
          initialFilePath: filePath,
        ),
      );

  group('ImportScreen — load error', () {
    testWidgets('shows error banner when getImporters fails', (tester) async {
      when(() => mockRepo.getImporters()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('unreachable')),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.byType(ErrorBanner), findsOneWidget);
    });

    testWidgets('retry button reloads importers', (tester) async {
      when(() => mockRepo.getImporters()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('down')),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      when(
        () => mockRepo.getImporters(),
      ).thenAnswer((_) async => (data: [_mt940], error: null));

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(find.byType(ErrorBanner), findsNothing);
      verify(() => mockRepo.getImporters()).called(2);
    });
  });

  group('ImportScreen — empty state (no file)', () {
    setUp(() {
      when(
        () => mockRepo.getImporters(),
      ).thenAnswer((_) async => (data: [_mt940, _beancount], error: null));
    });

    testWidgets('shows Choose a file button and instructions', (tester) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('Choose a file…'), findsOneWidget);
      expect(find.text('Or share from your banking app'), findsOneWidget);
      expect(find.text('Run Import'), findsNothing);
    });

    testWidgets('does not show importer dropdown without a file', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('MT940'), findsNothing);
      expect(find.text('Select importer'), findsNothing);
    });
  });

  group('ImportScreen — file ready state', () {
    setUp(() {
      when(
        () => mockRepo.getImporters(),
      ).thenAnswer((_) async => (data: [_mt940, _beancount], error: null));
    });

    testWidgets('shows file name and importer dropdown when file path set', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(filePath: '/tmp/statement.sta'));
      await tester.pumpAndSettle();

      expect(find.text('statement.sta'), findsOneWidget);
      expect(find.text('Select importer'), findsOneWidget);
      expect(find.text('Run Import'), findsOneWidget);
    });

    testWidgets('Run Import button disabled before importer selected', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(filePath: '/tmp/bank.sta'));
      await tester.pumpAndSettle();

      final button = tester.widget<ElevatedButton>(
        find.widgetWithText(ElevatedButton, 'Run Import'),
      );
      expect(button.onPressed, isNull);
    });

    testWidgets('Run Import button enabled after selecting importer', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(filePath: '/tmp/bank.sta'));
      await tester.pumpAndSettle();

      await tester.tap(find.byType(DropdownButton<String>));
      await tester.pump();
      await tester.tap(find.text('MT940').last);
      await tester.pumpAndSettle();

      final button = tester.widget<ElevatedButton>(
        find.widgetWithText(ElevatedButton, 'Run Import'),
      );
      expect(button.onPressed, isNotNull);
    });

    testWidgets('clear button removes file and hides Run Import', (
      tester,
    ) async {
      await tester.pumpWidget(buildScreen(filePath: '/tmp/bank.sta'));
      await tester.pumpAndSettle();

      await tester.tap(find.byIcon(Icons.close));
      await tester.pumpAndSettle();

      expect(find.text('statement.sta'), findsNothing);
      expect(find.text('Run Import'), findsNothing);
      expect(find.text('Choose a file…'), findsOneWidget);
    });
  });

  Future<void> selectImporter(WidgetTester tester, String name) async {
    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text(name).last, warnIfMissed: false);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  Future<void> submitImport(WidgetTester tester) async {
    // runAsync allows the real event loop (including dart:io file reads) to run.
    await tester.runAsync(() async {
      await tester.tap(find.text('Run Import'));
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pump(); // rebuild with result or error
  }

  group('ImportScreen — import result', () {
    late Directory tempDir;
    late File testFile;

    setUp(() async {
      when(
        () => mockRepo.getImporters(),
      ).thenAnswer((_) async => (data: [_mt940], error: null));

      tempDir = await Directory.systemTemp.createTemp('import_screen_test');
      testFile = File('${tempDir.path}/bank.sta');
      await testFile.writeAsBytes([1, 2, 3]);
    });

    tearDown(() async {
      await tempDir.delete(recursive: true);
    });

    testWidgets('shows result card with entity counts on success', (
      tester,
    ) async {
      when(
        () => mockRepo.importFile(
          importerName: any(named: 'importerName'),
          fieldName: any(named: 'fieldName'),
          filename: any(named: 'filename'),
          fileBytes: any(named: 'fileBytes'),
          mimeType: any(named: 'mimeType'),
        ),
      ).thenAnswer((_) async => (data: _result, error: null));

      await tester.pumpWidget(buildScreen(filePath: testFile.path));
      await tester.pumpAndSettle();

      await selectImporter(tester, 'MT940');
      await submitImport(tester);

      expect(find.text('Import complete'), findsOneWidget);
      expect(find.text('12'), findsOneWidget);
      expect(find.text('Created'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      expect(find.text('Duplicates'), findsOneWidget);
      expect(find.text('Done'), findsOneWidget);
      expect(find.text('Import Another'), findsOneWidget);
    });

    testWidgets('shows error examples and warnings in result', (tester) async {
      when(
        () => mockRepo.importFile(
          importerName: any(named: 'importerName'),
          fieldName: any(named: 'fieldName'),
          filename: any(named: 'filename'),
          fileBytes: any(named: 'fileBytes'),
          mimeType: any(named: 'mimeType'),
        ),
      ).thenAnswer((_) async => (data: _resultWithErrors, error: null));

      await tester.pumpWidget(buildScreen(filePath: testFile.path));
      await tester.pumpAndSettle();

      await selectImporter(tester, 'MT940');
      await submitImport(tester);

      expect(find.text('Import complete with errors'), findsOneWidget);
      expect(find.textContaining('Parse error on line 45'), findsOneWidget);
      expect(find.textContaining('Paperless not configured'), findsOneWidget);
    });

    testWidgets('Import Another resets to file ready state', (tester) async {
      when(
        () => mockRepo.importFile(
          importerName: any(named: 'importerName'),
          fieldName: any(named: 'fieldName'),
          filename: any(named: 'filename'),
          fileBytes: any(named: 'fileBytes'),
          mimeType: any(named: 'mimeType'),
        ),
      ).thenAnswer((_) async => (data: _result, error: null));

      await tester.pumpWidget(buildScreen(filePath: testFile.path));
      await tester.pumpAndSettle();

      await selectImporter(tester, 'MT940');
      await submitImport(tester);

      await tester.tap(find.text('Import Another'));
      await tester.pump();

      expect(find.text('Import complete'), findsNothing);
      expect(find.text('Choose a file…'), findsOneWidget);
    });

    testWidgets('shows error banner on importFile failure', (tester) async {
      when(
        () => mockRepo.importFile(
          importerName: any(named: 'importerName'),
          fieldName: any(named: 'fieldName'),
          filename: any(named: 'filename'),
          fileBytes: any(named: 'fileBytes'),
          mimeType: any(named: 'mimeType'),
        ),
      ).thenAnswer(
        (_) async => (
          data: null,
          error: const ServerError(400, 'validation_error', 'Config invalid'),
        ),
      );

      await tester.pumpWidget(buildScreen(filePath: testFile.path));
      await tester.pumpAndSettle();

      await selectImporter(tester, 'MT940');
      await submitImport(tester);

      expect(find.byType(ErrorBanner), findsOneWidget);
      expect(find.text('Run Import'), findsOneWidget);
    });

    testWidgets('onSettings callback fires from MissingSettingsError banner', (
      tester,
    ) async {
      when(() => mockRepo.getImporters()).thenAnswer(
        (_) async => (data: null, error: const MissingSettingsError()),
      );

      var settingsTapped = false;
      await tester.pumpWidget(
        buildScreen(onOpenSettings: () => settingsTapped = true),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();

      expect(settingsTapped, isTrue);
    });
  });
}
