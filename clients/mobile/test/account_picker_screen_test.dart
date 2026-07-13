import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/home_view.dart';
import 'package:family_ledger_mobile/models/account.dart';
import 'package:family_ledger_mobile/screens/add_transaction/account_picker_screen.dart';
import 'package:family_ledger_mobile/widgets/issue_bar.dart';

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
  group('home pseudo-views', () {
    Widget buildWithViews({HomeView? selectedHomeView}) => MaterialApp(
      home: AccountPickerScreen(
        accounts: _accounts,
        showHomeViews: true,
        selectedHomeView: selectedHomeView,
      ),
    );

    testWidgets('pinned at the top when opted in', (tester) async {
      await tester.pumpWidget(buildWithViews());
      await tester.pumpAndSettle();

      expect(find.text('Balance sheet'), findsOneWidget);
      expect(find.text('Income statement'), findsOneWidget);
    });

    testWidgets('hidden by default (posting-editing flows)', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();

      expect(find.text('Balance sheet'), findsNothing);
      expect(find.text('Income statement'), findsNothing);
    });

    testWidgets('hidden while searching', (tester) async {
      await tester.pumpWidget(buildWithViews());
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'food');
      await tester.pumpAndSettle();

      expect(find.text('Balance sheet'), findsNothing);
      expect(find.text('Income statement'), findsNothing);
    });

    testWidgets('checkmark on the currently shown view', (tester) async {
      await tester.pumpWidget(
        buildWithViews(selectedHomeView: HomeView.incomeStatement),
      );
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.check), findsOneWidget);
    });

    testWidgets('tapping a view pops with that HomeView', (tester) async {
      Object? picked;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                picked = await Navigator.push<Object>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => AccountPickerScreen(
                      accounts: _accounts,
                      showHomeViews: true,
                    ),
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

      await tester.tap(find.text('Income statement'));
      await tester.pumpAndSettle();

      expect(picked, HomeView.incomeStatement);
    });
  });

  group('closed accounts toggle', () {
    final withClosed = [
      ..._accounts,
      const AccountResource(
        name: 'accounts/assets_old',
        accountName: 'Assets:OldBank',
        effectiveStartDate: '2018-01-01',
        effectiveEndDate: '2022-12-31',
      ),
      AccountResource.prefix('Assets'),
    ];

    Widget buildWithClosed() =>
        MaterialApp(home: AccountPickerScreen(accounts: withClosed));

    testWidgets('closed accounts are hidden by default', (tester) async {
      await tester.pumpWidget(buildWithClosed());
      await tester.pumpAndSettle();

      expect(find.text('Show closed accounts'), findsOneWidget);
      expect(find.text('Assets · OldBank'), findsNothing);
      // Prefix entries always visible even though their end date is unset.
      expect(find.text('Assets'), findsOneWidget);
    });

    testWidgets('toggle reveals closed accounts', (tester) async {
      await tester.pumpWidget(buildWithClosed());
      await tester.pumpAndSettle();

      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();

      expect(find.text('Assets · OldBank'), findsOneWidget);
    });

    testWidgets('no toggle when every account is open', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();

      expect(find.text('Show closed accounts'), findsNothing);
    });

    testWidgets(
      'the current selection stays visible and checked even when closed',
      (tester) async {
        const oldBank = AccountResource(
          name: 'accounts/assets_old',
          accountName: 'Assets:OldBank',
          effectiveStartDate: '2018-01-01',
          effectiveEndDate: '2022-12-31',
        );
        await tester.pumpWidget(
          MaterialApp(
            home: AccountPickerScreen(accounts: withClosed, selected: oldBank),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Assets · OldBank'), findsOneWidget);
        expect(find.byIcon(Icons.check), findsOneWidget);
      },
    );
  });
  group('assertion issue indicators', () {
    testWidgets('marks accounts and their prefixes with a red bar', (
      tester,
    ) async {
      final accounts = [..._accounts, AccountResource.prefix('Assets')];
      await tester.pumpWidget(
        MaterialApp(
          home: AccountPickerScreen(
            accounts: accounts,
            issueAccountNames: const {'Assets:Cash:Wallet'},
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Two red bars: the account itself and its 'Assets' prefix subtree.
      expect(find.byType(IssueBar), findsNWidgets(2));
    });

    testWidgets('no red bars without issues', (tester) async {
      await tester.pumpWidget(buildPicker());
      await tester.pumpAndSettle();
      expect(find.byType(IssueBar), findsNothing);
    });

    testWidgets(
      'a flagged row is still fully tappable through the red bar strip',
      (tester) async {
        AccountResource? popped;
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () async {
                  popped = await Navigator.push<AccountResource>(
                    context,
                    MaterialPageRoute(
                      builder: (_) => AccountPickerScreen(
                        accounts: _accounts,
                        issueAccountNames: const {'Assets:Cash:Wallet'},
                      ),
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

        // Tap at the very left edge of the flagged row, inside the 4px
        // bar's footprint — the bar must not swallow this hit and prevent
        // the pop.
        final rowTopLeft = tester.getTopLeft(
          find.text('Assets · Cash · Wallet'),
        );
        await tester.tapAt(Offset(2, rowTopLeft.dy + 10));
        await tester.pumpAndSettle();

        expect(popped?.accountName, 'Assets:Cash:Wallet');
      },
    );
  });
}
