import 'package:flutter/material.dart';

/// Reset/title/Apply row shared by the filter bottom sheets, with the
/// divider that always sits directly beneath it.
class FilterSheetHeader extends StatelessWidget {
  final String title;
  final VoidCallback onReset;
  final VoidCallback onApply;

  const FilterSheetHeader({
    super.key,
    required this.title,
    required this.onReset,
    required this.onApply,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Row(
            children: [
              TextButton(
                onPressed: onReset,
                child: const Text(
                  'Reset',
                  style: TextStyle(color: Color(0xFF1A73E8)),
                ),
              ),
              Expanded(
                child: Text(
                  title,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF1C1C1E),
                  ),
                ),
              ),
              TextButton(
                onPressed: onApply,
                child: const Text(
                  'Apply',
                  style: TextStyle(color: Color(0xFF1A73E8)),
                ),
              ),
            ],
          ),
        ),
        const Divider(height: 1, color: Color(0xFFE5E5EA)),
      ],
    );
  }
}
