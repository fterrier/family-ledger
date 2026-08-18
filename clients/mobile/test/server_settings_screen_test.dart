import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:family_ledger_mobile/core/api_client.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/core/error_reporter.dart';
import 'package:family_ledger_mobile/core/secure_settings.dart';
import 'package:family_ledger_mobile/screens/settings/server_settings_screen.dart';
import 'package:family_ledger_mobile/widgets/error_banner.dart';

class MockSecureSettings extends Mock implements SecureSettings {}

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockSecureSettings mockSettings;
  late MockApiClient mockApiClient;

  setUp(() {
    mockSettings = MockSecureSettings();
    mockApiClient = MockApiClient();

    when(
      () => mockSettings.getBaseUrl(),
    ).thenAnswer((_) async => 'http://example.com');
    when(() => mockSettings.getToken()).thenAnswer((_) async => 'token');
    when(() => mockSettings.saveBaseUrl(any())).thenAnswer((_) async {});
    when(() => mockSettings.saveToken(any())).thenAnswer((_) async {});
  });

  void stubSuccess() {
    when(() => mockApiClient.checkHealth()).thenAnswer((_) async => null);
    when(
      () => mockApiClient.get(any(), queryParams: any(named: 'queryParams')),
    ).thenAnswer((_) async => (data: {'accounts': []}, error: null));
  }

  Widget buildScreen({
    VoidCallback? onSaved,
    Future<void> Function()? onServerChanged,
    ErrorReporter? errors,
  }) => MaterialApp(
    home: ServerSettingsScreen(
      settings: mockSettings,
      apiClient: mockApiClient,
      onSaved: onSaved,
      onServerChanged: onServerChanged ?? () async {},
      errors: errors ?? ErrorReporter(),
    ),
  );

  group('ServerSettingsScreen fields', () {
    testWidgets('shows stored URL on open', (tester) async {
      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('http://example.com'), findsOneWidget);
    });

    testWidgets('shows empty fields when nothing stored', (tester) async {
      when(() => mockSettings.getBaseUrl()).thenAnswer((_) async => null);
      when(() => mockSettings.getToken()).thenAnswer((_) async => null);

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      final urlField = tester.widget<TextFormField>(
        find.byType(TextFormField).first,
      );
      expect(urlField.controller?.text, isEmpty);
    });
  });

  group('ServerSettingsScreen Connect — success', () {
    testWidgets('calls onServerChanged and pops on success', (tester) async {
      stubSuccess();
      var serverChangedCalled = false;

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => Navigator.push<bool>(
                context,
                MaterialPageRoute(
                  builder: (_) => ServerSettingsScreen(
                    settings: mockSettings,
                    apiClient: mockApiClient,
                    onServerChanged: () async => serverChangedCalled = true,
                    errors: ErrorReporter(),
                  ),
                ),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(serverChangedCalled, isTrue);
      expect(find.text('Open'), findsOneWidget);
      expect(find.text('Server'), findsNothing);
    });

    testWidgets('calls onSaved instead of popping in initial setup', (
      tester,
    ) async {
      stubSuccess();
      var savedCalled = false;

      await tester.pumpWidget(buildScreen(onSaved: () => savedCalled = true));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Connect'));
      // onSaved doesn't pop (the parent rebuilds the widget tree), so the
      // spinner stays on screen and pumpAndSettle would time out. Pump once
      // to drain all the mocked async work instead.
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(savedCalled, isTrue);
    });
  });

  group('ServerSettingsScreen Connect — failure', () {
    testWidgets('shows error and stays when server unreachable', (
      tester,
    ) async {
      when(
        () => mockApiClient.checkHealth(),
      ).thenAnswer((_) async => const NetworkError('unreachable'));
      final errors = ErrorReporter();

      await tester.pumpWidget(buildScreen(errors: errors));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(errors.value, const NetworkError('unreachable'));
      // Routed through the shared ErrorBanner message table instead of this
      // screen's own copy, so the message includes the underlying
      // NetworkError text rather than a bespoke "Check the URL." hint.
      expect(find.text('Cannot reach server. unreachable'), findsOneWidget);
      expect(find.byType(ErrorBanner), findsOneWidget);
      expect(find.text('Connect'), findsOneWidget);
    });

    testWidgets('shows error and stays on bad token', (tester) async {
      when(() => mockApiClient.checkHealth()).thenAnswer((_) async => null);
      when(
        () => mockApiClient.get(any(), queryParams: any(named: 'queryParams')),
      ).thenAnswer((_) async => (data: null, error: const AuthError()));

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      // Same shared-message-table switch as above.
      expect(
        find.text('Authentication failed. Check your API token.'),
        findsOneWidget,
      );
      expect(find.byType(ErrorBanner), findsOneWidget);
      expect(find.text('Connect'), findsOneWidget);
    });

    testWidgets('does not call onServerChanged on failure', (tester) async {
      when(
        () => mockApiClient.checkHealth(),
      ).thenAnswer((_) async => const NetworkError('unreachable'));
      var serverChangedCalled = false;

      await tester.pumpWidget(
        buildScreen(onServerChanged: () async => serverChangedCalled = true),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(serverChangedCalled, isFalse);
    });
  });
}
