import 'package:flutter/material.dart';
import '../models/commodity.dart';

class CurrencyPickerSheet extends StatelessWidget {
  final List<Commodity> commodities;
  final String? selected;
  final String title;

  const CurrencyPickerSheet({
    super.key,
    required this.commodities,
    this.selected,
    this.title = 'Currency',
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              title,
              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
            ),
          ),
          if (commodities.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text(
                'No currencies available',
                style: TextStyle(color: Color(0xFF8E8E93)),
              ),
            )
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: commodities
                    .map(
                      (c) => ListTile(
                        title: Text(c.symbol),
                        trailing: c.symbol == selected
                            ? const Icon(Icons.check, color: Color(0xFF1A73E8))
                            : null,
                        onTap: () => Navigator.pop(context, c.symbol),
                      ),
                    )
                    .toList(),
              ),
            ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
