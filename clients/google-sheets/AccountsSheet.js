function syncFamilyLedgerAccounts() {
  runUserAction_('Sync Accounts', function() {
    ensureEditTriggerInstalled_();
    const accounts = fetchFamilyLedgerPagedResource_(
      '/accounts?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
      'accounts'
    );
    const displayEntries = buildAccountDisplayEntries_(accounts).sort(function(a, b) {
      return a.display_name.localeCompare(b.display_name);
    });

    const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
    const rows = displayEntries.map(function(entry) {
      return [entry.display_name, entry.name, ''];
    });

    writeConfigSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts, rows);
    sheet.setFrozenRows(1);
    ensureAccountIssueFormulas_(sheet, rows.length);
    applyManagedSheetLayout_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts);
    refreshDoctorIssueSheets_();
    SpreadsheetApp.getUi().alert(
      'Account Sync Complete',
      'Synced ' + accounts.length + ' accounts.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  });
}

function buildAccountDisplayEntries_(accounts) {
  return accounts.map(function(account) {
    return {
      name: account.name,
      account_name: account.account_name,
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
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  const mapping = {};
  if (lastRow <= 1) {
    throw new Error('Accounts sheet is empty. Run Sync Accounts first.');
  }

  const rows = accountsSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  rows.forEach(function(row) {
    if (row[0] && row[1]) {
      mapping[String(row[0])] = String(row[1]);
    }
  });
  return mapping;
}

function resolveAccountResourceName_(accountNameMap, accountName) {
  const resourceName = accountNameMap[accountName];
  if (!resourceName) {
    throw new Error('Unknown account_name: ' + accountName);
  }
  return resourceName;
}

function loadAccountsFromApi_() {
  const accounts = fetchFamilyLedgerPagedResource_(
    '/accounts?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
    'accounts'
  );
  const displayEntries = buildAccountDisplayEntries_(accounts);
  const lookup = {};
  displayEntries.forEach(function(account) {
    lookup[account.name] = account.display_name;
  });
  return lookup;
}

function getTransactionAccountNames() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.accounts);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  const names = [];
  values.forEach(function(row) {
    if (row[0]) names.push(String(row[0]));
  });
  names.sort();
  return names;
}

function buildAccountIssuesFormula_(rowNumber) {
  return '=IFERROR(VLOOKUP($B' + rowNumber + ',DoctorAccountIssues!$A:$B,2,FALSE),"")';
}

function ensureAccountIssueFormulas_(sheet, rowCount) {
  const issuesColumn = getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.accounts, 'issues');
  if (rowCount <= 0) {
    return;
  }
  const formulas = [];
  for (let rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    formulas.push([buildAccountIssuesFormula_(rowNumber)]);
  }
  sheet.getRange(2, issuesColumn, rowCount, 1).setFormulas(formulas);
}

function applyAccountValidation_(sheet, rowCount) {
  // TODO: Improve account UX beyond dropdown validation, especially for large account lists.
  if (rowCount === 0) {
    return;
  }

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 1, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  sheet.getRange(2, destinationColumn, rowCount, 1).setDataValidation(rule);
}

function applyAccountValidationToRowNumbers_(sheet, rowNumbers) {
  if (rowNumbers.length === 0) {
    return;
  }

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 1, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, destinationColumn).setDataValidation(rule);
  });
}
