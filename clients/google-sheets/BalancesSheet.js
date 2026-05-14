function buildBalanceAssertionSyncRows_(balanceAssertions, accountResourceToDisplayName) {
  return balanceAssertions.map(function(assertion) {
    const accountDisplay = accountResourceToDisplayName[assertion.account] || assertion.account;
    return [
      assertion.name,
      assertion.assertion_date,
      accountDisplay,
      assertion.amount.amount,
      assertion.amount.symbol,
      '',
    ];
  });
}

function ensureBalancesIssueFormulas_(sheet, rowCount) {
  ensureManagedSheetIssueFormulas_(
    sheet,
    FAMILY_LEDGER_SHEET_REGISTRY.balances,
    rowCount
  );
}
