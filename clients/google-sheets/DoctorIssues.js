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

function partitionDoctorIssuesBySheet_(issuesByTarget) {
  const grouped = {};
  FAMILY_LEDGER_DOCTOR_TARGET_REGISTRY.forEach(function(entry) {
    grouped[entry.doctorSheetName] = {};
  });
  const unknownTargets = [];

  Object.keys(issuesByTarget).forEach(function(target) {
    const registryEntry = getDoctorTargetConfigForTarget_(target);
    if (!registryEntry) {
      unknownTargets.push(target);
      return;
    }
    grouped[registryEntry.doctorSheetName][target] = issuesByTarget[target];
  });

  return {
    grouped: grouped,
    unknownTargets: unknownTargets,
  };
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

function doctorIssuesToSheetRows_(issuesByTarget) {
  return Object.keys(issuesByTarget)
    .sort()
    .map(function(target) {
      const issues = issuesByTarget[target] || [];
      return [
        target,
        formatDoctorIssueCodesForSheet_(issues),
        formatDoctorIssuesForSheet_(issues),
      ];
    });
}

function mergeDoctorIssuesIntoRows_(rows, issuesByTarget) {
  rows.forEach(function(row) {
    row.issues = formatDoctorIssuesForSheet_(issuesByTarget[row.resource_name] || []);
  });
}

function mergeFetchedDoctorIssuesIntoRows_(rows) {
  const issuesByTarget = fetchLedgerDoctorIssuesByTarget_();
  mergeDoctorIssuesIntoRows_(rows, issuesByTarget);
  return issuesByTarget;
}

function refreshVisibleLedgerIssuesFromDoctor_() {
  try {
    const issuesByTarget = refreshDoctorIssueSheets_();
    refreshManagedVisibleSheetIssues_(issuesByTarget);
  } catch (error) {
    debugLog_('refreshVisibleLedgerIssuesFromDoctor:error', {
      message: error && error.message ? error.message : String(error),
    });
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Saved changes, but failed to refresh ledger doctor issues: ' + (error.message || String(error)),
      'Family Ledger',
      5
    );
  }
}

function refreshDoctorIssueSheets_() {
  const issuesByTarget = fetchLedgerDoctorIssuesByTarget_();
  debugLog_('refreshDoctorIssueSheets:fetched', {
    issueCount: Object.values(issuesByTarget).reduce(function(total, issues) {
      return total + issues.length;
    }, 0),
  });
  writeFetchedDoctorIssueSheets_(issuesByTarget, getOrCreateSheet_);
  return issuesByTarget;
}

function writeFetchedDoctorIssueSheets_(issuesByTarget, resolveSheet) {
  const partitioned = partitionDoctorIssuesBySheet_(issuesByTarget);
  FAMILY_LEDGER_DOCTOR_TARGET_REGISTRY.forEach(function(entry) {
    writeDoctorIssueSheet_(
      resolveSheet(entry.doctorSheetName),
      doctorIssuesToSheetRows_(partitioned.grouped[entry.doctorSheetName] || {})
    );
  });
  debugLog_('refreshDoctorIssueSheets:written', {
    doctorSheets: FAMILY_LEDGER_DOCTOR_TARGET_REGISTRY.map(function(entry) {
      return {
        sheetName: entry.doctorSheetName,
        targetCount: Object.keys(partitioned.grouped[entry.doctorSheetName] || {}).length,
      };
    }),
    unknownTargets: partitioned.unknownTargets,
  });
}

function refreshManagedVisibleSheetIssues_(issuesByTarget) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  FAMILY_LEDGER_DOCTOR_TARGET_REGISTRY.forEach(function(entry) {
    const sheet = spreadsheet.getSheetByName(entry.visibleSheetName);
    if (!sheet) {
      return;
    }
    applyDoctorIssuesToVisibleSheet_(sheet, issuesByTarget);
  });
}

function applyDoctorIssuesToVisibleSheet_(sheet, issuesByTarget) {
  const sheetConfig = getSheetConfigByName_(sheet.getName());
  const existing = readVisibleRowsForIssueRefresh_(sheet, sheetConfig);
  mergeDoctorIssuesIntoRows_(existing.rows, issuesByTarget);
  debugLog_('applyDoctorIssuesToVisibleSheet', {
    sheetName: sheet.getName(),
    visibleRowCount: existing.rowNumbers.length,
    issueTargetCount: Object.keys(issuesByTarget).length,
  });
  applyDoctorIssuesToRowNumbers_(sheet, sheetConfig, existing.rowNumbers, existing.rows);
}

function readVisibleRowsForIssueRefresh_(sheet, sheetConfig) {
  return readVisibleSheetRows_(sheet, sheetConfig);
}

function applyDoctorIssuesToRowNumbers_(sheet, sheetConfig, rowNumbers, rows) {
  if (!rowNumbers || rowNumbers.length === 0) {
    return;
  }
  const issuesColumn = getColumnIndex_(sheetConfig, 'issues');
  rowNumbers.forEach(function(rowNumber, index) {
    sheet.getRange(rowNumber, issuesColumn).setValue(rows[index].issues || '');
  });
}

function writeDoctorIssueSheet_(sheet, rows) {
  writeSheet_(sheet, FAMILY_LEDGER_DOCTOR_ISSUES_HEADERS, rows);
  hideSheetIfVisible_(sheet);
}
