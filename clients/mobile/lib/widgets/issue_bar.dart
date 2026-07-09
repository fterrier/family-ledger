import 'package:flutter/material.dart';

/// The 4px red vertical indicator marking a row with a doctor issue, shared
/// by the transaction list and the account picker. Position with a
/// [Positioned] as the last child of the row's [Stack].
///
/// Wrapped in [IgnorePointer]: [ColoredBox] hit-tests as opaque by default,
/// which would otherwise steal taps landing on this strip before they reach
/// the row's [InkWell]/[GestureDetector].
class IssueBar extends StatelessWidget {
  static const color = Color(0xFFFF3B30);

  const IssueBar({super.key});

  @override
  Widget build(BuildContext context) {
    return const IgnorePointer(
      child: SizedBox(width: 4, child: ColoredBox(color: color)),
    );
  }
}
