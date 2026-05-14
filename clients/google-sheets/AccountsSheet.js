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

function loadAccountMaps_() {
  const entries = readAccountSheetEntries_();
  const nameMap = {};
  const displayLookup = {};
  entries.forEach(function(entry) {
    if (entry.displayName && entry.resourceName) {
      nameMap[entry.displayName] = entry.resourceName;
      displayLookup[entry.resourceName] = entry.displayName;
    }
  });
  return { nameMap: nameMap, displayLookup: displayLookup };
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


function ensureAccountIssueFormulas_(sheet, rowCount) {
  ensureManagedSheetIssueFormulas_(
    sheet,
    FAMILY_LEDGER_SHEET_REGISTRY.accounts,
    rowCount
  );
}

function buildAccountValidationRule_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) return null;
  return {
    rule: SpreadsheetApp.newDataValidation()
      .requireValueInRange(accountsSheet.getRange(2, 2, lastRow - 1, 1), true)
      .setAllowInvalid(false)
      .build(),
    destinationColumn: getTransactionHeaderColumnIndex_('destination_account_name'),
  };
}

function applyAccountValidation_(sheet, rowCount) {
  if (rowCount === 0) return;
  clearTransactionAccountValidationColumns_(sheet, 2, rowCount);
  // TODO: Improve account UX beyond dropdown validation, especially for large account lists.
  const validation = buildAccountValidationRule_();
  if (!validation) return;
  sheet.getRange(2, validation.destinationColumn, rowCount, 1).setDataValidation(validation.rule);
}


function applyAccountValidationToRowNumbers_(sheet, rowNumbers) {
  if (rowNumbers.length === 0) return;
  clearTransactionAccountValidationRows_(sheet, rowNumbers);
  const validation = buildAccountValidationRule_();
  if (!validation) return;
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, validation.destinationColumn).setDataValidation(validation.rule);
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
