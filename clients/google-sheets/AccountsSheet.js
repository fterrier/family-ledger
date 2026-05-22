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

function loadAccountOptions_() {
  return readAccountSheetEntries_()
    .filter(function(entry) { return entry.resourceName && entry.displayName; })
    .map(function(entry) {
      return {
        resource_name: entry.resourceName,
        display_name: entry.displayName,
        start_date: normalizeEntityDate_(entry.startDate) || null,
        end_date: normalizeEntityDate_(entry.endDate) || null,
      };
    })
    .sort(function(a, b) { return a.display_name.localeCompare(b.display_name); });
}

function readAccountSheetEntries_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    throw new Error('Accounts sheet is empty. Run Sync Ledger first.');
  }

  const accConfig = FAMILY_LEDGER_SHEET_REGISTRY.accounts;
  return managedSheet_(accountsSheet, accConfig)
    .getRows({ start: 2, count: lastRow - 1 }, ['resource_name', 'account_name', 'effective_start_date', 'effective_end_date'])
    .map(function(row) {
      return {
        resourceName: row.resource_name ? String(row.resource_name) : '',
        displayName: row.account_name ? String(row.account_name) : '',
        startDate: row.effective_start_date || null,
        endDate: row.effective_end_date || null,
      };
    });
}

function buildAccountValidationRule_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) return null;
  const accConfig = FAMILY_LEDGER_SHEET_REGISTRY.accounts;
  const today = normalizeEntityDate_(new Date());
  const activeNames = managedSheet_(accountsSheet, accConfig)
    .getRows({ start: 2, count: lastRow - 1 }, ['account_name', 'effective_start_date', 'effective_end_date'])
    .filter(function(row) {
      if (!row.account_name) return false;
      const start = normalizeEntityDate_(row.effective_start_date);
      const end = normalizeEntityDate_(row.effective_end_date);
      if (start && start > today) return false;
      if (end && end < today) return false;
      return true;
    })
    .map(function(row) { return row.account_name; });
  if (activeNames.length === 0) return null;
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(activeNames, true)
    .setAllowInvalid(false)
    .build();
}

function refreshAccountValidation_(sheet, sheetConfig, span) {
  const resolvedSpan = span || { start: 2, count: Math.max((sheet.getLastRow ? sheet.getLastRow() : 1) - 1, 0) };
  if (resolvedSpan.count === 0) return;
  const accountHeaders = sheetConfig.headers.filter(function(h) {
    return (sheetConfig.columnLayout[h] || {}).validation === 'account';
  });
  if (accountHeaders.length === 0) return;
  const rule = buildAccountValidationRule_();
  const ms = managedSheet_(sheet, sheetConfig);
  accountHeaders.forEach(function(h) {
    if (rule) {
      ms.setColumnValidation(resolvedSpan, h, rule);
    } else {
      ms.clearColumnValidations(resolvedSpan, [h]);
    }
  });
}
