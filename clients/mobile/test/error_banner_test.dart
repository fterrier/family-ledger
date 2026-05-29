import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/widgets/error_banner.dart';

Widget _wrap(ErrorBanner banner) => MaterialApp(home: Scaffold(body: banner));

void main() {
  group('ErrorBanner messages', () {
    testWidgets('NetworkError shows message and Retry button', (tester) async {
      var retryCalled = false;
      await tester.pumpWidget(
        _wrap(
          ErrorBanner(
            error: const NetworkError('timeout'),
            onRetry: () => retryCalled = true,
          ),
        ),
      );

      expect(find.text('Cannot reach server. timeout'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);

      await tester.tap(find.text('Retry'));
      expect(retryCalled, isTrue);
    });

    testWidgets('NetworkError without onRetry shows no button', (tester) async {
      await tester.pumpWidget(
        _wrap(const ErrorBanner(error: NetworkError('timeout'))),
      );

      expect(find.text('Cannot reach server. timeout'), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
    });

    testWidgets('AuthError shows message and Settings button', (tester) async {
      var settingsCalled = false;
      await tester.pumpWidget(
        _wrap(
          ErrorBanner(
            error: const AuthError(),
            onSettings: () => settingsCalled = true,
          ),
        ),
      );

      expect(
        find.text('Authentication failed. Check your API token.'),
        findsOneWidget,
      );
      expect(find.text('Settings'), findsOneWidget);

      await tester.tap(find.text('Settings'));
      expect(settingsCalled, isTrue);
    });

    testWidgets('AuthError without onSettings shows no button', (tester) async {
      await tester.pumpWidget(
        _wrap(const ErrorBanner(error: AuthError())),
      );

      expect(
        find.text('Authentication failed. Check your API token.'),
        findsOneWidget,
      );
      expect(find.text('Settings'), findsNothing);
    });

    testWidgets('ValidationError shows message with no button', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const ErrorBanner(
            error: ValidationError('Amount must be positive.'),
          ),
        ),
      );

      expect(find.text('Amount must be positive.'), findsOneWidget);
      expect(find.byType(TextButton), findsNothing);
    });

    testWidgets('ServerError shows server error message with no button',
        (tester) async {
      await tester.pumpWidget(
        _wrap(
          const ErrorBanner(
            error: ServerError(500, 'internal', 'Unexpected failure'),
          ),
        ),
      );

      expect(find.text('Server error: Unexpected failure'), findsOneWidget);
      expect(find.byType(TextButton), findsNothing);
    });

    testWidgets('MissingSettingsError shows message and Settings button',
        (tester) async {
      var settingsCalled = false;
      await tester.pumpWidget(
        _wrap(
          ErrorBanner(
            error: const MissingSettingsError(),
            onSettings: () => settingsCalled = true,
          ),
        ),
      );

      expect(find.text('Server not configured.'), findsOneWidget);
      expect(find.text('Settings'), findsOneWidget);

      await tester.tap(find.text('Settings'));
      expect(settingsCalled, isTrue);
    });
  });
}
