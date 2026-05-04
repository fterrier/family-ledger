function buildBalanceAssertionSyncRows_(balanceAssertions, accountDisplayLookup) {
  return balanceAssertions.map(function(assertion) {
    const accountDisplay = accountDisplayLookup[assertion.account] || assertion.account;
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
    FAMILY_LEDGER_SHEET_NAMES.doctorBalanceAssertionIssues,
    rowCount
  );
}
