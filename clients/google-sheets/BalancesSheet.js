function buildBalanceAssertionSyncRows_(balanceAssertions, accountResourceToDisplayName) {
  return balanceAssertions.map(function(assertion) {
    return {
      resource_name: assertion.name,
      assertion_date: assertion.assertion_date,
      account: accountResourceToDisplayName[assertion.account] || assertion.account,
      amount: assertion.amount.amount,
      symbol: assertion.amount.symbol,
      issues: '',
    };
  });
}

function ensureBalancesIssueFormulas_(sheet, span) {
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.balances).setColumnFormulas(span, 'issues', buildIssueLookupFormula_);
}
