import 'package:flutter/material.dart';

enum AccountCategory { expense, income, asset, liability, equity }

class AccountCategoryTheme {
  final Color lightBg;
  final Color color;
  final IconData icon;

  const AccountCategoryTheme({
    required this.lightBg,
    required this.color,
    required this.icon,
  });
}

const noAccountTheme = AccountCategoryTheme(
  lightBg: Color(0xFFF2F2F7),
  color: Color(0xFFC7C7CC),
  icon: Icons.account_balance_wallet,
);

const accountCategoryThemes = <AccountCategory, AccountCategoryTheme>{
  AccountCategory.expense: AccountCategoryTheme(
    lightBg: Color(0xFFFFEBEE),
    color: Color(0xFFEF9A9A),
    icon: Icons.arrow_downward,
  ),
  AccountCategory.income: AccountCategoryTheme(
    lightBg: Color(0xFFE8F5E9),
    color: Color(0xFF81C784),
    icon: Icons.arrow_upward,
  ),
  AccountCategory.asset: AccountCategoryTheme(
    lightBg: Color(0xFFE3F2FD),
    color: Color(0xFF64B5F6),
    icon: Icons.account_balance,
  ),
  AccountCategory.liability: AccountCategoryTheme(
    lightBg: Color(0xFFFFF3E0),
    color: Color(0xFFFFB74D),
    icon: Icons.credit_card,
  ),
  AccountCategory.equity: AccountCategoryTheme(
    lightBg: Color(0xFFF5F5F5),
    color: Color(0xFFAEAEB2),
    icon: Icons.equalizer,
  ),
};

AccountCategory categoryOf(String? accountName) {
  if (accountName == null) return AccountCategory.equity;
  if (accountName.startsWith('Expenses:')) return AccountCategory.expense;
  if (accountName.startsWith('Income:')) return AccountCategory.income;
  if (accountName.startsWith('Assets:')) return AccountCategory.asset;
  if (accountName.startsWith('Liabilities:')) return AccountCategory.liability;
  return AccountCategory.equity;
}

AccountCategoryTheme themeForAccount(String? accountName) {
  if (accountName == null || accountName.isEmpty) return noAccountTheme;
  return accountCategoryThemes[categoryOf(accountName)]!;
}
