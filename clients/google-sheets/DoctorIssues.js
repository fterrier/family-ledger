function formatTransactionIssuesForSheet_(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return '';
  }
  return issues.map(formatTransactionIssueForSheet_).join('\n');
}

function formatTransactionIssueForSheet_(issue) {
  if (!issue || !issue.code) {
    return '';
  }
  const details = issue.details || {};
  if (issue.code === 'transaction_unbalanced') {
    const parts = [];
    if (details.symbol) {
      parts.push(String(details.symbol));
    }
    if (details.residual_amount) {
      parts.push('residual ' + String(details.residual_amount));
    }
    if (details.tolerance_amount) {
      parts.push('tolerance ' + String(details.tolerance_amount));
    }
    return 'transaction_unbalanced' + (parts.length > 0 ? ' (' + parts.join(', ') + ')' : '');
  }
  return issue.code + (issue.message ? ': ' + issue.message : '');
}

function fetchLedgerDoctorIssuesByTarget_() {
  const response = apiFetchJson_('post', '/ledger:doctor', {});
  const byTarget = {};
  const issues = Array.isArray(response.issues) ? response.issues : [];
  issues.forEach(function(issue) {
    if (!issue || !issue.target) {
      return;
    }
    if (!byTarget[issue.target]) {
      byTarget[issue.target] = [];
    }
    byTarget[issue.target].push(issue);
  });
  debugLog_('fetchLedgerDoctorIssuesByTarget', {
    issueCount: issues.length,
    targetCount: Object.keys(byTarget).length,
    sampleTargets: Object.keys(byTarget).slice(0, 5),
  });
  return byTarget;
}

function partitionDoctorIssuesByTargetType_(issuesByTarget) {
  const transactionIssues = {};
  const accountIssues = {};
  Object.keys(issuesByTarget).forEach(function(target) {
    if (target.indexOf('transactions/') === 0) {
      transactionIssues[target] = issuesByTarget[target];
      return;
    }
    if (target.indexOf('accounts/') === 0) {
      accountIssues[target] = issuesByTarget[target];
    }
  });
  return {
    transactionIssues: transactionIssues,
    accountIssues: accountIssues,
  };
}

function doctorIssuesToSheetRows_(issuesByTarget) {
  return Object.keys(issuesByTarget)
    .sort()
    .map(function(target) {
      return [target, formatTransactionIssuesForSheet_(issuesByTarget[target] || [])];
    });
}

function mergeDoctorIssuesIntoRows_(rows, issuesByTarget) {
  rows.forEach(function(row) {
    row.issues = formatTransactionIssuesForSheet_(issuesByTarget[row.transaction_name] || []);
  });
}

function mergeFetchedDoctorIssuesIntoRows_(rows) {
  const issuesByTarget = fetchLedgerDoctorIssuesByTarget_();
  mergeDoctorIssuesIntoRows_(rows, issuesByTarget);
  return issuesByTarget;
}

function refreshTransactionIssuesFromDoctor_(sheet, transactionName) {
  try {
    refreshDoctorIssueSheets_(transactionName);
  } catch (error) {
    debugLog_('refreshTransactionIssuesFromDoctor:error', {
      transactionName: transactionName || '',
      message: error && error.message ? error.message : String(error),
    });
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Saved transaction, but failed to refresh ledger doctor issues: ' + (error.message || String(error)),
      'Family Ledger',
      5
    );
  }
}

function refreshDoctorIssueSheets_(transactionName) {
  const issuesByTarget = fetchLedgerDoctorIssuesByTarget_();
  const partitioned = partitionDoctorIssuesByTargetType_(issuesByTarget);
  debugLog_('refreshTransactionIssuesFromDoctorSync:fetched', {
    transactionName: transactionName || '',
    issueCount: Object.values(issuesByTarget).reduce(function(total, issues) {
      return total + issues.length;
    }, 0),
    targetFound: transactionName ? Object.prototype.hasOwnProperty.call(issuesByTarget, transactionName) : false,
  });
  writeDoctorIssueSheet_(
    getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.doctorTransactionIssues),
    doctorIssuesToSheetRows_(partitioned.transactionIssues)
  );
  writeDoctorIssueSheet_(
    getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.doctorAccountIssues),
    doctorIssuesToSheetRows_(partitioned.accountIssues)
  );
  debugLog_('refreshDoctorIssueSheets:written', {
    transactionIssueTargets: Object.keys(partitioned.transactionIssues).length,
    accountIssueTargets: Object.keys(partitioned.accountIssues).length,
    transactionName: transactionName || '',
  });
}

function applyFetchedDoctorIssuesToExistingSheet_(sheet, issuesByTarget, transactionName) {
  const existing = readVisibleTransactionRows_(sheet);
  mergeDoctorIssuesIntoRows_(existing.rows, issuesByTarget);
  const targetRow = transactionName
    ? existing.rows.find(function(row) {
      return row.transaction_name === transactionName;
    })
    : null;
  debugLog_('applyFetchedDoctorIssuesToExistingSheet', {
    transactionName: transactionName || '',
    visibleRowCount: existing.rowNumbers.length,
    rowFound: !!targetRow,
    mergedIssues: targetRow ? String(targetRow.issues || '') : '',
  });
  applyDoctorIssuesToSheetRowNumbers_(sheet, existing.rowNumbers, existing.rows);
}

function applyDoctorIssuesToSheetRowNumbers_(sheet, rowNumbers, rows) {
  if (!rowNumbers || rowNumbers.length === 0) {
    return;
  }
  const issuesColumn = getTransactionHeaderColumnIndex_('issues');
  rowNumbers.forEach(function(rowNumber, index) {
    sheet.getRange(rowNumber, issuesColumn).setValue(rows[index].issues || '');
  });
}

function writeDoctorIssueSheet_(sheet, rows) {
  writeSheet_(sheet, FAMILY_LEDGER_DOCTOR_ISSUES_HEADERS, rows);
  hideSheetIfVisible_(sheet);
}
