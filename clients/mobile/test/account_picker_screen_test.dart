import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/screens/add_transaction/account_picker_screen.dart';

AccountResource _acct(String accountName) => AccountResource(
  name: 'accounts/${accountName.toLowerCase().replaceAll(':', '_')}',
  accountName: accountName,
  effectiveStartDate: '2020-01-01',
);

final _accounts = [
  _acct('Assets:Cash:Wallet'),
  _acct('Expenses:Food:Restaurant'),
  _acct('Expenses:Transport'),
  _acct('Income:Salary'),
];

Widget buildPicker({AccountResource? selected}) => MaterialApp(
  home: AccountPickerScreen(accounts: _accounts, selected: selected),
);

void main() {
  group('AccountPickerScreen display', () {
    testWidgets('shows all accounts initially', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
      expect(find.text('Expenses · Food · Restaurant'), findsOneWidget);
      expect(find.text('Expenses · Transport'), findsOneWidget);
      expect(find.text('Income · Salary'), findsOneWidget);
    });

    testWidgets('shows checkmark on selected account', (tester) async {
      await tester.pumpWidget(
        buildPicker(selected: _acct('Assets:Cash:Wallet')),
      );
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.check), findsOneWidget);
    });

    testWidgets('no checkmark when no account is selected', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.check), findsNothing);
    });
  });

  group('AccountPickerScreen search', () {
    testWidgets('filters accounts by typed query', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'food');
      await tester.pumpAndSettle();

      // Matching accounts render as RichText (highlighted characters).
      expect(
        find.text('Expenses · Food · Restaurant', findRichText: true),
        findsOneWidget,
      );
      expect(
        find.text('Assets · Cash · Wallet', findRichText: true),
        findsNothing,
      );
      expect(find.text('Income · Salary', findRichText: true), findsNothing);
    });

    testWidgets('ordered-character fuzzy search works', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();

      // 'efr' matches Expenses:Food:Restaurant via ordered characters
      await tester.enterText(find.byType(TextField), 'efr');
      await tester.pumpAndSettle();

      expect(
        find.text('Expenses · Food · Restaurant', findRichText: true),
        findsOneWidget,
      );
      expect(
        find.text('Assets · Cash · Wallet', findRichText: true),
        findsNothing,
      );
    });

    testWidgets('clearing search restores full list', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'food');
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), '');
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsOneWidget);
      expect(find.text('Expenses · Food · Restaurant'), findsOneWidget);
      expect(find.text('Expenses · Transport'), findsOneWidget);
      expect(find.text('Income · Salary'), findsOneWidget);
    });

    testWidgets('no-match query shows empty list', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'zzzzz');
      await tester.pumpAndSettle();

      expect(find.text('Assets · Cash · Wallet'), findsNothing);
      expect(find.text('Expenses · Food · Restaurant'), findsNothing);
    });
  });

  group('AccountPickerScreen selection', () {
    testWidgets('tapping account pops with that account', (tester) async {
      AccountResource? picked;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                picked = await Navigator.push<AccountResource>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => AccountPickerScreen(accounts: _accounts),
                  ),
                );
              },
              child: const Text('Open'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Expenses · Transport'));
      await tester.pumpAndSettle();

      expect(picked?.accountName, 'Expenses:Transport');
    });

    testWidgets('Cancel button pops with null', (tester) async {
      AccountResource? picked;
      var popCalled = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                picked = await Navigator.push<AccountResource>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => AccountPickerScreen(accounts: _accounts),
                  ),
                );
                popCalled = true;
              },
              child: const Text('Open'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(popCalled, isTrue);
      expect(picked, isNull);
    });
  });
}
