import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/core/app_preferences.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/models/commodity.dart';
import 'package:family_ledger_mobile/repositories/account_repository.dart';
import 'package:family_ledger_mobile/repositories/commodity_repository.dart';
import 'package:family_ledger_mobile/core/error_reporter.dart';
import 'package:family_ledger_mobile/screens/settings/app_settings_screen.dart';
import 'package:family_ledger_mobile/widgets/error_banner.dart';

class MockAccountRepository extends Mock implements AccountRepository {}

class MockCommodityRepository extends Mock implements CommodityRepository {}

AccountResource _acct(String accountName) => AccountResource(
  name: 'accounts/${accountName.toLowerCase().replaceAll(':', '_')}',
  accountName: accountName,
  effectiveStartDate: '2020-01-01',
);

Commodity _commodity(String symbol) =>
    Commodity(name: 'commodities/${symbol.toLowerCase()}', symbol: symbol);

void main() {
  late MockAccountRepository mockRepo;
  late MockCommodityRepository mockCommodityRepo;

  setUp(() {
    mockRepo = MockAccountRepository();
    mockCommodityRepo = MockCommodityRepository();

    when(
      () => mockCommodityRepo.getAllCommodities(),
    ).thenAnswer((_) async => (data: <Commodity>[], error: null));
  });

  Widget buildScreen({ErrorReporter? errors}) => MaterialApp(
    home: AppSettingsScreen(
      accountRepository: mockRepo,
      commodityRepository: mockCommodityRepo,
      errors: errors ?? ErrorReporter(),
    ),
  );

  group('AppSettingsScreen default From account', () {
    testWidgets('shows None when no default is stored', (tester) async {
      SharedPreferences.setMockInitialValues({});
      when(() => mockRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: [_acct('Assets:Cash:Wallet')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('None'), findsWidgets);
    });

    testWidgets('shows stored account displayName on open', (tester) async {
      SharedPreferences.setMockInitialValues({
        AppPreferences.keyDefaultFrom: 'Assets:Cash:Wallet',
      });
      when(() => mockRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: [_acct('Assets:Cash:Wallet')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
    });

    testWidgets('shows None when stored account no longer exists in list', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        AppPreferences.keyDefaultFrom: 'Assets:Cash:OldWallet',
      });
      when(() => mockRepo.getAllAccounts()).thenAnswer(
        (_) async => (data: [_acct('Assets:Cash:Wallet')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsNothing);
    });

    testWidgets(
      'picking an account updates display and saves to SharedPreferences',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(() => mockRepo.getAllAccounts()).thenAnswer(
          (_) async => (
            data: [_acct('Assets:Cash:Wallet'), _acct('Expenses:Food')],
            error: null,
          ),
        );

        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('None').first);
        await tester.pumpAndSettle();

        expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
        await tester.tap(find.text('Assets · Cash · Wallet'));
        await tester.pumpAndSettle();

        expect(find.text('Assets · Cash · Wallet'), findsOneWidget);

        final prefs = await SharedPreferences.getInstance();
        expect(
          prefs.getString(AppPreferences.keyDefaultFrom),
          'Assets:Cash:Wallet',
        );
      },
    );

    testWidgets(
      'row is disabled and tap does nothing when accounts failed to load',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(() => mockRepo.getAllAccounts()).thenAnswer(
          (_) async => (data: null, error: const NetworkError('unreachable')),
        );

        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('None').first);
        await tester.pumpAndSettle();

        expect(find.text('App Settings'), findsOneWidget);
        expect(find.text('Select Account'), findsNothing);
      },
    );

    testWidgets(
      'shows an error banner when accounts fail to load '
      '(regression: the row just went silently disabled with no explanation)',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(() => mockRepo.getAllAccounts()).thenAnswer(
          (_) async => (data: null, error: const NetworkError('unreachable')),
        );
        final errors = ErrorReporter();

        await tester.pumpWidget(buildScreen(errors: errors));
        await tester.pumpAndSettle();

        expect(errors.value, const NetworkError('unreachable'));
        expect(find.byType(ErrorBanner), findsOneWidget);
      },
    );

    testWidgets(
      'retrying clears the stale error banner immediately, before the new '
      'fetch resolves (regression: _load() only reported errors.value after '
      'the await, so the old banner stayed up alongside the new loading '
      'spinners for the whole retry, reading as "still failing")',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(() => mockRepo.getAllAccounts()).thenAnswer(
          (_) async => (data: null, error: const NetworkError('unreachable')),
        );
        final errors = ErrorReporter();

        await tester.pumpWidget(buildScreen(errors: errors));
        await tester.pumpAndSettle();
        expect(find.byType(ErrorBanner), findsOneWidget);

        final retry =
            Completer<({List<AccountResource>? data, ApiError? error})>();
        when(() => mockRepo.getAllAccounts()).thenAnswer((_) => retry.future);

        await tester.tap(find.text('Retry'));
        await tester.pump();

        // The fetch hasn't resolved yet, but the stale banner must already
        // be gone.
        expect(find.byType(ErrorBanner), findsNothing);
        expect(errors.value, isNull);

        retry.complete((data: <AccountResource>[], error: null));
        await tester.pumpAndSettle();
      },
    );

    testWidgets(
      'onOpenSettings callback fires from a MissingSettingsError banner '
      '(regression: the screen had no onOpenSettings field at all, so an '
      'AuthError/MissingSettingsError banner here had no action button, '
      'unlike every sibling screen)',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(() => mockRepo.getAllAccounts()).thenAnswer(
          (_) async => (data: null, error: const MissingSettingsError()),
        );

        var settingsTapped = false;
        await tester.pumpWidget(
          MaterialApp(
            home: AppSettingsScreen(
              accountRepository: mockRepo,
              commodityRepository: mockCommodityRepo,
              errors: ErrorReporter(),
              onOpenSettings: () => settingsTapped = true,
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.text('Settings'));
        await tester.pumpAndSettle();

        expect(settingsTapped, isTrue);
      },
    );
  });

  group('AppSettingsScreen default Currency', () {
    testWidgets('shows None when no default currency is stored', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      when(
        () => mockRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async =>
            (data: [_commodity('CHF'), _commodity('EUR')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('None'), findsWidgets);
    });

    testWidgets('shows stored default currency on open', (tester) async {
      SharedPreferences.setMockInitialValues({
        AppPreferences.keyDefaultCurrency: 'EUR',
      });
      when(
        () => mockRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async =>
            (data: [_commodity('CHF'), _commodity('EUR')], error: null),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      expect(find.text('EUR'), findsOneWidget);
    });

    testWidgets(
      'picking a currency updates display and saves to SharedPreferences',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(
          () => mockRepo.getAllAccounts(),
        ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
        when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
          (_) async =>
              (data: [_commodity('CHF'), _commodity('EUR')], error: null),
        );

        await tester.pumpWidget(buildScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('None').last);
        await tester.pumpAndSettle();

        expect(find.text('CHF'), findsOneWidget);
        expect(find.text('EUR'), findsOneWidget);

        await tester.tap(find.text('EUR'));
        await tester.pumpAndSettle();

        expect(find.text('EUR'), findsOneWidget);

        final prefs = await SharedPreferences.getInstance();
        expect(prefs.getString(AppPreferences.keyDefaultCurrency), 'EUR');
      },
    );

    testWidgets('currency row is disabled when no commodities loaded', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      when(
        () => mockRepo.getAllAccounts(),
      ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
      when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
        (_) async => (data: null, error: const NetworkError('unreachable')),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();

      await tester.tap(find.text('None').last);
      await tester.pumpAndSettle();

      expect(find.text('Default Currency'), findsNothing);
    });

    testWidgets(
      'shows an error banner when commodities fail to load '
      '(regression: the row just went silently disabled with no explanation)',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        when(
          () => mockRepo.getAllAccounts(),
        ).thenAnswer((_) async => (data: <AccountResource>[], error: null));
        when(() => mockCommodityRepo.getAllCommodities()).thenAnswer(
          (_) async => (data: null, error: const NetworkError('unreachable')),
        );
        final errors = ErrorReporter();

        await tester.pumpWidget(buildScreen(errors: errors));
        await tester.pumpAndSettle();

        expect(errors.value, const NetworkError('unreachable'));
        expect(find.byType(ErrorBanner), findsOneWidget);
      },
    );
  });
}
