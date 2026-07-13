/// The two pseudo-views shown when no account is selected: a balance sheet
/// (net worth line over Assets + Liabilities) and an income statement
/// (net per-period bars over Income + Expenses). Values are raw ledger
/// signs throughout — no inversion.
enum HomeView {
  balanceSheet(
    label: 'Balance sheet',
    rootAccounts: ['Assets', 'Liabilities'],
    isFlow: false,
  ),
  incomeStatement(
    label: 'Income statement',
    rootAccounts: ['Income', 'Expenses'],
    isFlow: true,
  );

  const HomeView({
    required this.label,
    required this.rootAccounts,
    required this.isFlow,
  });

  final String label;

  /// Top-level account subtrees the view nets over (raw signs make the
  /// netting automatic; Equity is the residual and excluded by design).
  final List<String> rootAccounts;

  /// Flow views chart per-bucket bars; stock views a running-balance line.
  final bool isFlow;
}
