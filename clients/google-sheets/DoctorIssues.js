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

function buildNavigateLabelLookup_(spreadsheet, neededTargets, accountLookup) {
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
        const txRows = txSheet.getRange(2, 1, lastTxRow - 1, 3).getValues();
        const seen = {};
        txRows.forEach(function(row) {
          const name = String(row[0] || '');
          if (name && targetSet[name] && !seen[name]) {
            seen[name] = true;
            const parts = ['Transaction'];
            if (row[1]) { parts.push(row[1]); }
            if (row[2]) { parts.push(row[2]); }
            lookup[name] = parts.join(' ');
          }
        });
      }
    }
  }

  Object.keys(accountLookup || {}).forEach(function(resourceName) {
    if (targetSet[resourceName]) {
      const displayName = accountLookup[resourceName];
      lookup[resourceName] = displayName ? 'Account ' + displayName : 'Account';
    }
  });

  const balSheet = spreadsheet.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.balances);
  if (balSheet) {
    const lastBalRow = balSheet.getLastRow();
    if (lastBalRow > 1) {
      balSheet.getRange(2, 1, lastBalRow - 1, 3).getValues().forEach(function(row) {
        const resourceName = row[0];
        if (resourceName && targetSet[resourceName]) {
          const parts = ['Balance'];
          if (row[1]) { parts.push(row[1]); }
          if (row[2]) { parts.push(row[2]); }
          lookup[resourceName] = parts.join(' ');
        }
      });
    }
  }

  return lookup;
}

function buildNavigateFormula_(labelText, visibleSheetName, visibleSheetGid, rowNumber) {
  const escaped = String(labelText).replace(/"/g, '""');
  const matchPart = 'MATCH(A' + rowNumber + ',' + visibleSheetName + '!$A:$A,0)';
  const urlPart = '"#gid=' + visibleSheetGid + '&range=B"&' + matchPart;
  return '=IFERROR(HYPERLINK(' + urlPart + ',"' + escaped + '"),"' + escaped + '")';
}

function refreshDoctorIssueSheets_(accountLookup) {
  const issuesByTarget = fetchLedgerDoctorIssuesByTarget_();
  debugLog_('refreshDoctorIssueSheets:fetched', {
    issueCount: Object.values(issuesByTarget).reduce(function(total, issues) {
      return total + issues.length;
    }, 0),
  });
  writeFetchedDoctorIssueSheets_(issuesByTarget, getOrCreateSheet_, accountLookup);
  return issuesByTarget;
}

function writeFetchedDoctorIssueSheets_(issuesByTarget, resolveSheet, accountLookup) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const issueSheet = resolveSheet(FAMILY_LEDGER_SHEET_NAMES.issues);
  const sortedTargets = Object.keys(issuesByTarget).sort();
  const labelLookup = buildNavigateLabelLookup_(spreadsheet, sortedTargets, accountLookup);
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
        navigate = buildNavigateFormula_(labelText, name, String(visibleSheet.getSheetId()), rowNumber);
      }
    }
    return [
      target,
      navigate,
      formatDoctorIssueCodesForSheet_(issues),
      formatDoctorIssuesForSheet_(issues),
    ];
  });

  writeSheet_(issueSheet, FAMILY_LEDGER_SHEET_REGISTRY.issues.headers, dataRows);

  debugLog_('writeFetchedDoctorIssueSheets', {
    issueCount: Object.values(issuesByTarget).reduce(function(total, issues) {
      return total + issues.length;
    }, 0),
    targetCount: sortedTargets.length,
  });
}
