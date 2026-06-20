import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';

/// Formats a raw amount string for display: comma thousands-separator,
/// minimum 2 decimal places, preserves more decimals if present.
/// Returns [rawValue] unchanged if it cannot be parsed (e.g. partial input).
String formatDisplayAmount(String rawValue) {
  final stripped = rawValue.replaceAll(',', '');
  final v = double.tryParse(stripped);
  if (v == null) return rawValue;

  final dotIndex = stripped.indexOf('.');
  final decimalPlaces = dotIndex < 0 ? 0 : stripped.length - dotIndex - 1;
  final displayDecimals = decimalPlaces < 2 ? 2 : decimalPlaces;

  return NumberFormat('#,##0.${'0' * displayDecimals}', 'en_US').format(v);
}

String rawEditAmount(String displayValue) => displayValue.replaceAll(',', '');

/// Wires a focus listener that strips commas on focus-gain and reformats on
/// focus-loss. Skips the assignment when the value would be unchanged.
void wireAmountFocus(FocusNode node, TextEditingController ctrl) {
  node.addListener(() {
    final next = node.hasFocus
        ? rawEditAmount(ctrl.text)
        : formatDisplayAmount(ctrl.text);
    if (next != ctrl.text) ctrl.text = next;
  });
}
