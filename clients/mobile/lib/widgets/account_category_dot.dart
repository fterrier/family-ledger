import 'package:flutter/material.dart';
import '../core/account_category.dart';

/// Colored circle identifying an account's top-level category, with an
/// optional icon glyph inside.
class AccountCategoryDot extends StatelessWidget {
  final AccountCategoryTheme theme;
  final double size;
  final double? iconSize;

  const AccountCategoryDot({
    super.key,
    required this.theme,
    required this.size,
    this.iconSize,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: theme.color, shape: BoxShape.circle),
      child: iconSize != null
          ? Icon(theme.icon, size: iconSize, color: Colors.white)
          : null,
    );
  }
}
