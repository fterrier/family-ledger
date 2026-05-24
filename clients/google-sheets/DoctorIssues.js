function formatDoctorIssuesForSheet_(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return '';
  }
  return issues.map(formatDoctorIssueForSheet_).filter(Boolean).join('\n');
}

function formatDoctorIssueForSheet_(issue) {
  if (!issue || !issue.code) {
    return '';
  }
  const message = issue.message ? String(issue.message) : '';
  const details = formatDoctorIssueDetailsForSheet_(issue.details || {});
  let formatted = message || String(issue.code);
  if (details) {
    formatted += ' (' + details + ')';
  }
  return formatted;
}

function formatDoctorIssueCodesForSheet_(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return '';
  }
  return issues.map(function(issue) {
    return issue && issue.code ? String(issue.code) : '';
  }).filter(Boolean).join('\n');
}

function formatDoctorIssueDetailsForSheet_(details) {
  const keys = Object.keys(details).filter(function(key) {
    return details[key] !== undefined && details[key] !== null && String(details[key]) !== '';
  }).sort();
  return keys.map(function(key) {
    return key + ' ' + String(details[key]);
  }).join(', ');
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

function getDoctorTargetConfigForTarget_(target) {
  for (let index = 0; index < FAMILY_LEDGER_DOCTOR_TARGET_REGISTRY.length; index += 1) {
    const entry = FAMILY_LEDGER_DOCTOR_TARGET_REGISTRY[index];
    if (target.indexOf(entry.targetPrefix) === 0) {
      return entry;
    }
  }
  return null;
}

function buildNavigateLabel_(target, targetSummary, accountResourceToDisplayName) {
  const s = targetSummary || {};
  if (target.indexOf('accounts/') === 0) {
    return 'Account ' + (accountResourceToDisplayName[target] || target.split('/').slice(1).join('/'));
  }
  if (target.indexOf('transactions/') === 0) {
    const parts = ['Transaction'];
    if (s.date) parts.push(s.date);
    if (s.payee) parts.push(s.payee);
    return parts.join(' ');
  }
  if (target.indexOf('balanceAssertions/') === 0) {
    const parts = ['Balance'];
    if (s.date) parts.push(s.date);
    if (s.account) parts.push(s.account);
    return parts.join(' ');
  }
  if (target.indexOf('attachments/') === 0) {
    const parts = ['Attachment'];
    if (s.date) parts.push(s.date);
    if (s.account) parts.push(s.account);
    return parts.join(' ');
  }
  return target;
}

function buildNavigateFormula_(labelText, visibleSheetName, visibleSheetGid, rowNumber, resourceNameCol, navigateCol) {
  const escaped = String(labelText).replace(/"/g, '""');
  const matchPart = 'MATCH(A' + rowNumber + ',' + visibleSheetName + '!$' + resourceNameCol + ':$' + resourceNameCol + ',0)';
  const urlPart = '"#gid=' + visibleSheetGid + '&range=' + navigateCol + '"&' + matchPart;
  return '=IFERROR(HYPERLINK(' + urlPart + ',"' + escaped + '"),"' + escaped + '")';
}

function refreshDoctorIssueSheets_(accountResourceToDisplayName) {
  const issuesByTarget = fetchLedgerDoctorIssuesByTarget_();
  debugLog_('refreshDoctorIssueSheets:fetched', {
    issueCount: Object.values(issuesByTarget).reduce(function(total, issues) {
      return total + issues.length;
    }, 0),
  });
  writeFetchedDoctorIssueSheets_(issuesByTarget, getOrCreateSheet_, accountResourceToDisplayName);
  return issuesByTarget;
}

function writeFetchedDoctorIssueSheets_(issuesByTarget, resolveSheet, accountResourceToDisplayName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const issueSheet = resolveSheet(FAMILY_LEDGER_SHEET_NAMES.issues);
  // Sort alphabetically by resource name so the Issues sheet has a stable, consistent order.
  // The VLOOKUP formulas on entity sheets depend on this; the Issues sheet data must not change
  // row positions between syncs or formula results become stale until manually re-triggered.
  const sortedTargets = Object.keys(issuesByTarget).sort();
  const sheetByName = {};
  const dataRows = sortedTargets.map(function(target, index) {
    const issues = issuesByTarget[target] || [];
    const rowNumber = index + 2;
    const registryEntry = getDoctorTargetConfigForTarget_(target);
    const targetSummary = (issues[0] || {}).target_summary || {};
    const labelText = buildNavigateLabel_(target, targetSummary, accountResourceToDisplayName);
    let navigate = labelText;
    if (registryEntry) {
      const name = registryEntry.visibleSheetName;
      if (!(name in sheetByName)) {
        sheetByName[name] = spreadsheet.getSheetByName(name);
      }
      const visibleSheet = sheetByName[name];
      if (visibleSheet) {
        const targetSheetConfig = getSheetConfigByName_(name);
        const resourceNameCol = getColumnLetter_(targetSheetConfig, 'resource_name');
        const firstVisibleHeader = targetSheetConfig.headers.find(function(h) {
          return targetSheetConfig.hiddenHeaders.indexOf(h) === -1;
        });
        const navigateCol = getColumnLetter_(targetSheetConfig, firstVisibleHeader);
        navigate = buildNavigateFormula_(labelText, name, String(visibleSheet.getSheetId()), rowNumber, resourceNameCol, navigateCol);
      }
    }
    return {
      target: target,
      navigate: navigate,
      issue_codes: formatDoctorIssueCodesForSheet_(issues),
      issues_text: formatDoctorIssuesForSheet_(issues),
    };
  });

  writeSheet_(issueSheet, FAMILY_LEDGER_SHEET_REGISTRY.issues, dataRows);

  debugLog_('writeFetchedDoctorIssueSheets', {
    issueCount: Object.values(issuesByTarget).reduce(function(total, issues) {
      return total + issues.length;
    }, 0),
    targetCount: sortedTargets.length,
  });
}
