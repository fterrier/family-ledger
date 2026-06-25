import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/widgets/expandable_fab.dart';

Widget _wrap({VoidCallback? onAddTransaction, VoidCallback? onImport}) =>
    MaterialApp(
      home: Scaffold(
        floatingActionButton: ExpandableFab(
          onAddTransaction: onAddTransaction ?? () {},
          onImport: onImport ?? () {},
        ),
      ),
    );

Finder _primaryFab() => find.byWidgetPredicate(
  (w) => w is FloatingActionButton && w.heroTag == 'fab_add',
);

Finder _importFab() => find.byWidgetPredicate(
  (w) => w is FloatingActionButton && w.heroTag == 'fab_import',
);

void main() {
  group('ExpandableFab initial state', () {
    testWidgets('import button starts with scale 0 (invisible)', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap());
      final scaleTransition = tester.widget<ScaleTransition>(
        find.byKey(const Key('fab_import_scale')),
      );
      expect(scaleTransition.scale.value, closeTo(0.0, 0.01));
    });
  });

  group('ExpandableFab tap (no drag)', () {
    testWidgets('tap on primary triggers onAddTransaction', (tester) async {
      var addCalled = 0, importCalled = 0;
      await tester.pumpWidget(
        _wrap(
          onAddTransaction: () => addCalled++,
          onImport: () => importCalled++,
        ),
      );

      final center = tester.getCenter(_primaryFab());
      final gesture = await tester.startGesture(center);
      await tester.pump(const Duration(milliseconds: 250));
      await gesture.up();
      await tester.pumpAndSettle();

      expect(addCalled, 1);
      expect(importCalled, 0);
    });

    testWidgets('import button collapses after tap release', (tester) async {
      await tester.pumpWidget(_wrap());

      final center = tester.getCenter(_primaryFab());
      final gesture = await tester.startGesture(center);
      await tester.pump(const Duration(milliseconds: 250));
      await gesture.up();
      await tester.pumpAndSettle();

      final scaleTransition = tester.widget<ScaleTransition>(
        find.byKey(const Key('fab_import_scale')),
      );
      expect(scaleTransition.scale.value, closeTo(0.0, 0.01));
    });
  });

  group('ExpandableFab drag to import', () {
    testWidgets('dragging to import button triggers onImport', (tester) async {
      var addCalled = 0, importCalled = 0;
      await tester.pumpWidget(
        _wrap(
          onAddTransaction: () => addCalled++,
          onImport: () => importCalled++,
        ),
      );

      final center = tester.getCenter(_primaryFab());
      final gesture = await tester.startGesture(center);
      await tester.pump(const Duration(milliseconds: 250));

      final importCenter = tester.getCenter(_importFab());
      await gesture.moveTo(importCenter);
      await tester.pump();
      await gesture.up();
      await tester.pumpAndSettle();

      expect(importCalled, 1);
      expect(addCalled, 0);
    });

    testWidgets('import button highlights when hovered', (tester) async {
      await tester.pumpWidget(_wrap());

      final center = tester.getCenter(_primaryFab());
      final gesture = await tester.startGesture(center);
      await tester.pump(const Duration(milliseconds: 250));

      final importCenter = tester.getCenter(_importFab());
      await gesture.moveTo(importCenter);
      await tester.pump();

      final importButton = tester.widget<FloatingActionButton>(_importFab());
      expect(importButton.backgroundColor, const Color(0xFF1A73E8));

      await gesture.cancel();
      await tester.pumpAndSettle();
    });
  });

  group('ExpandableFab drag sideways', () {
    testWidgets('dragging sideways does not highlight import button', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap());

      final center = tester.getCenter(_primaryFab());
      final gesture = await tester.startGesture(center);
      await tester.pump(const Duration(milliseconds: 250));
      // Move sideways (not toward the import button which is above)
      await gesture.moveBy(const Offset(-40, 0));
      await tester.pump();

      final importButton = tester.widget<FloatingActionButton>(_importFab());
      expect(importButton.backgroundColor, Colors.white); // not highlighted

      await gesture.cancel();
      await tester.pumpAndSettle();
    });
  });

  group('ExpandableFab cancel', () {
    testWidgets('pointer cancel fires no callback and collapses', (
      tester,
    ) async {
      var addCalled = 0, importCalled = 0;
      await tester.pumpWidget(
        _wrap(
          onAddTransaction: () => addCalled++,
          onImport: () => importCalled++,
        ),
      );

      final center = tester.getCenter(_primaryFab());
      final gesture = await tester.startGesture(center);
      await tester.pump(const Duration(milliseconds: 250));
      await gesture.cancel();
      await tester.pumpAndSettle();

      expect(addCalled, 0);
      expect(importCalled, 0);

      final scaleTransition = tester.widget<ScaleTransition>(
        find.byKey(const Key('fab_import_scale')),
      );
      expect(scaleTransition.scale.value, closeTo(0.0, 0.01));
    });
  });
}
