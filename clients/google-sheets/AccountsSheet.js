function buildAccountDisplayEntries_(accounts) {
  return accounts.map(function(account) {
    return {
      account_name: account.account_name,
      resource_name: account.name,
      display_name: formatAccountDisplayName_(account.account_name),
    };
  });
}

function formatAccountDisplayName_(accountName) {
  const canonical = String(accountName || '').trim();
  if (!canonical) {
    return canonical;
  }
  const segments = canonical.split(':');
  const root = segments[0];
  const marker = FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS[root] || '[?]';
  const tail = segments.length > 1 ? segments.slice(1) : segments;
  return marker + ' ' + tail.join(' - ');
}

function loadAccountNameMap_() {
  const mapping = {};
  readAccountSheetEntries_().forEach(function(entry) {
    if (entry.displayName && entry.resourceName) {
      mapping[entry.displayName] = entry.resourceName;
    }
  });
  return mapping;
}

function loadAccountDisplayLookup_() {
  const lookup = {};
  readAccountSheetEntries_().forEach(function(entry) {
    if (entry.displayName && entry.resourceName) {
      lookup[entry.resourceName] = entry.displayName;
    }
  });
  return lookup;
}

function readAccountSheetEntries_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    throw new Error('Accounts sheet is empty. Run Sync Ledger first.');
  }

  return accountsSheet.getRange(2, 1, lastRow - 1, 2).getValues().map(function(row) {
    return {
      resourceName: row[0] ? String(row[0]) : '',
      displayName: row[1] ? String(row[1]) : '',
    };
  });
}

function resolveAccountResourceName_(accountNameMap, accountName) {
  const resourceName = accountNameMap[accountName];
  if (!resourceName) {
    throw new Error('Unknown account_name: ' + accountName);
  }
  return resourceName;
}

function getTransactionAccountNames() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.accounts);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  const names = [];
  values.forEach(function(row) {
    if (row[0]) names.push(String(row[0]));
  });
  names.sort();
  return names;
}

function ensureAccountIssueFormulas_(sheet, rowCount) {
  ensureManagedSheetIssueFormulas_(
    sheet,
    FAMILY_LEDGER_SHEET_REGISTRY.accounts,
    FAMILY_LEDGER_SHEET_NAMES.doctorAccountIssues,
    rowCount
  );
}

function applyAccountValidation_(sheet, rowCount) {
  if (rowCount === 0) {
    return;
  }

  clearTransactionAccountValidationColumns_(sheet, 2, rowCount);

  // TODO: Improve account UX beyond dropdown validation, especially for large account lists.

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 2, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  sheet.getRange(2, destinationColumn, rowCount, 1).setDataValidation(rule);
}

function applyAccountValidationToRowNumbers_(sheet, rowNumbers) {
  if (rowNumbers.length === 0) {
    return;
  }

  clearTransactionAccountValidationRows_(sheet, rowNumbers);

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 2, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, destinationColumn).setDataValidation(rule);
  });
}

function refreshTransactionAccountValidation_(sheet) {
  applyAccountValidation_(sheet, Math.max((sheet.getLastRow ? sheet.getLastRow() : 1) - 1, 0));
}

function clearTransactionAccountValidationColumns_(sheet, startRow, rowCount) {
  if (rowCount <= 0) {
    return;
  }
  const sourceColumn = getTransactionHeaderColumnIndex_('source_account_name');
  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  sheet.getRange(startRow, sourceColumn, rowCount, 1).clearDataValidations();
  sheet.getRange(startRow, destinationColumn, rowCount, 1).clearDataValidations();
}

function clearTransactionAccountValidationRows_(sheet, rowNumbers) {
  if (rowNumbers.length === 0) {
    return;
  }
  const sourceColumn = getTransactionHeaderColumnIndex_('source_account_name');
  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, sourceColumn).clearDataValidations();
    sheet.getRange(rowNumber, destinationColumn).clearDataValidations();
  });
}
