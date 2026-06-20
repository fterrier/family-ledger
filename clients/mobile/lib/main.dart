import 'package:flutter/material.dart';
import 'app.dart';

void main() {
  runApp(
    const MaterialApp(
      title: 'Family Ledger',
      debugShowCheckedModeBanner: false,
      scrollBehavior: _NoOverscrollBehavior(),
      home: FamilyLedgerApp(),
    ),
  );
}

// Removes Material 3's StretchingOverscrollIndicator (Android) and
// GlowingOverscrollIndicator (older Android) without affecting RefreshIndicator.
class _NoOverscrollBehavior extends ScrollBehavior {
  const _NoOverscrollBehavior();

  @override
  Widget buildOverscrollIndicator(
    BuildContext context,
    Widget child,
    ScrollableDetails details,
  ) => child;
}
