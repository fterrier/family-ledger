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

function buildNavigateLabelLookup_(spreadsheet, neededTargets, accountResourceToDisplayName) {
  const lookup = {};
  const targetSet = {};
  neededTargets.forEach(function(t) { targetSet[t] = true; });

  let txNeededCount = 0;
  neededTargets.forEach(function(t) { if (t.indexOf('transactions/') === 0) txNeededCount++; });
  if (txNeededCount > 0) {
    const txSheet = spreadsheet.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
    if (txSheet) {
      const lastTxRow = txSheet.getLastRow();
      if (lastTxRow > 1) {
        const txConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
        const seen = {};
        managedSheet_(txSheet, txConfig)
          .getRows({ start: 2, count: lastTxRow - 1 }, ['resource_name', 'transaction_date', 'payee'])
          .forEach(function(row) {
            const name = String(row.resource_name || '');
            if (name && targetSet[name] && !seen[name]) {
              seen[name] = true;
              const parts = ['Transaction'];
              if (row.transaction_date) { parts.push(normalizeEntityDate_(row.transaction_date)); }
              if (row.payee) { parts.push(row.payee); }
              lookup[name] = parts.join(' ');
            }
          });
      }
    }
  }

  Object.keys(accountResourceToDisplayName).forEach(function(resourceName) {
    if (targetSet[resourceName]) {
      const displayName = accountResourceToDisplayName[resourceName];
      lookup[resourceName] = displayName ? 'Account ' + displayName : 'Account';
    }
  });

  const balSheet = spreadsheet.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.balances);
  if (balSheet) {
    const lastBalRow = balSheet.getLastRow();
    if (lastBalRow > 1) {
      const balConfig = FAMILY_LEDGER_SHEET_REGISTRY.balances;
      managedSheet_(balSheet, balConfig)
        .getRows({ start: 2, count: lastBalRow - 1 }, ['resource_name', 'assertion_date', 'account'])
        .forEach(function(row) {
          const resourceName = row.resource_name;
          if (resourceName && targetSet[resourceName]) {
            const parts = ['Balance'];
            if (row.assertion_date) { parts.push(normalizeEntityDate_(row.assertion_date)); }
            if (row.account) { parts.push(row.account); }
            lookup[resourceName] = parts.join(' ');
          }
        });
    }
  }

  return lookup;
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
  const sortedTargets = Object.keys(issuesByTarget).sort();
  const labelLookup = buildNavigateLabelLookup_(spreadsheet, sortedTargets, accountResourceToDisplayName);
  const sheetByName = {};
  const dataRows = sortedTargets.map(function(target, index) {
    const issues = issuesByTarget[target] || [];
    const rowNumber = index + 2;
    const registryEntry = getDoctorTargetConfigForTarget_(target);
    const labelText = labelLookup[target] || target;
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
